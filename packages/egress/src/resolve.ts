import { beforeDeadline, Deadline } from './deadline.ts';
import { checkPolicy } from './policy.ts';
import type { Runtime } from './runtime.ts';
import { admitAddress, checkBareHost, type CheckedHost } from './target.ts';
import type { CheckedAddress, EgressError, EgressPolicy, Result } from './types.ts';

const failure = (error: EgressError) => ({ ok: false, error }) as const;

/**
 * Resolves once and checks every answer. One internal answer refuses the whole name:
 * an attacker who controls DNS can order answers however they like.
 */
export async function resolveHost(
  runtime: Runtime,
  checked: CheckedHost,
  policy: EgressPolicy,
  deadline: Deadline,
  hop: number,
): Promise<Result<readonly CheckedAddress[], EgressError>> {
  if (checked.literal !== undefined) return { ok: true, value: [checked.literal] };
  let answers;
  try {
    answers = await beforeDeadline(deadline, runtime.lookup(checked.host));
  } catch {
    return failure({ code: 'egress.dns_failed', hop });
  }
  if (answers === undefined) return failure({ code: deadline.code, hop });
  const seen = new Set<string>();
  const addresses: CheckedAddress[] = [];
  for (const { address } of answers.value) {
    if (seen.has(address)) continue;
    seen.add(address);
    const admitted = admitAddress(address, policy);
    if (admitted === undefined) return failure({ code: 'egress.dns_failed', hop });
    if (!admitted.ok) {
      return failure({ code: 'egress.address_denied', hop, addressClass: admitted.addressClass });
    }
    addresses.push(admitted.value);
  }
  if (addresses.length === 0) return failure({ code: 'egress.dns_failed', hop });
  return { ok: true, value: addresses };
}

export async function guardedResolveWith(
  runtime: Runtime,
  host: string,
  policy: EgressPolicy,
): Promise<Result<readonly CheckedAddress[], EgressError>> {
  checkPolicy(policy);
  const checked = checkBareHost(host, policy);
  if (!checked.ok) return checked;
  const deadline = new Deadline(policy.totalTimeoutMs);
  try {
    return await resolveHost(runtime, checked.value, policy, deadline, 0);
  } finally {
    deadline.dispose();
  }
}
