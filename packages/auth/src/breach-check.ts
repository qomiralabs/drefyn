import type { AuthLogger, AuthMetrics } from './rate-limiter.ts';
import { quietWarn } from './session-support.ts';

// The open core reads an operator built file; hosted wires a range API behind the same shape.
export interface BreachedPasswordCheck {
  // true when known breached; null when the check could not answer in time
  isBreached(password: string, signal: AbortSignal): Promise<boolean | null>;
}

// A local file answers in well under a millisecond, and a hosted lookup gets the same second.
export const BREACH_CHECK_TIMEOUT_MS = 1_000;

export interface AskBreachedDeps {
  readonly logger: AuthLogger;
  readonly metrics?: AuthMetrics | undefined;
  // Ids for the log line; never the password or its digest.
  readonly fields: Readonly<Record<string, string>>;
}

type Answer = boolean | 'timeout' | 'error' | 'no_answer';

// True only when the check says breached. Anything else accepts the password: the check is
// hygiene when a password is chosen, not a gate that should stop sign up during an outage.
export async function askBreached(
  check: BreachedPasswordCheck | undefined,
  password: string,
  deps: AskBreachedDeps,
): Promise<boolean> {
  if (check === undefined) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked: Promise<Answer> = (async () => {
    try {
      const answer = await check.isBreached(password, controller.signal);
      return answer ?? 'no_answer';
    } catch {
      return 'error';
    }
  })();
  // A check that ignores the signal still loses the race; its late answer is dropped.
  const answer = await Promise.race([
    asked,
    new Promise<Answer>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, BREACH_CHECK_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (typeof answer === 'boolean') return answer;
  quietWarn(deps.logger, 'auth.breach_check_unavailable', { ...deps.fields, reason: answer });
  try {
    deps.metrics?.increment('auth.breach_check_unavailable');
  } catch {
    // A counter is never worth a failed request.
  }
  return false;
}
