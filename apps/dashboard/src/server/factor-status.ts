import type { SessionInfo } from '@drefyn/auth';
import type { FactorFacts } from '../settings/factor-words.ts';
import { dashboardAuth } from './auth.ts';
import { totpFlag } from './flags.ts';

// What the sign in methods page shows of the second factor. A failed read shows a row that
// says so only where enrolment is released, so an outage never reveals a flagged feature.
export async function factorFacts(session: SessionInfo): Promise<FactorFacts | null> {
  const auth = await dashboardAuth();
  const status = await auth.secondFactors.status(session);
  if (status.ok) return status.value;
  try {
    const on: unknown = await totpFlag.isOn('auth.totp', { userId: session.userId });
    return on === true ? 'failed' : null;
  } catch {
    return null;
  }
}
