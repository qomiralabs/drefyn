import fc from 'fast-check';
import { classifyAddress } from '../src/address.ts';
import { policyFor } from '../src/policy.ts';
import { checkTarget } from '../src/target.ts';
import {
  dotted,
  urlArbitrary,
  v4Arbitrary,
  v4IsPublic,
  v4Spellings,
  v6Arbitrary,
  v6IsPublic,
  v6Spellings,
} from './oracle.ts';

const POLICY = policyFor('monitor');
const DENIED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export interface FuzzOptions {
  readonly seconds: number;
  readonly seed: number;
  // A stricter check on top of the rules; the test uses it to prove failures are seen.
  readonly check?: (url: string) => boolean;
}

export interface FuzzReport {
  readonly runs: number;
  readonly failure: string | undefined;
}

function v4Agrees(value: number): boolean {
  const pub = v4IsPublic(value);
  const plain = classifyAddress(dotted(value));
  const mapped = classifyAddress(`::ffff:${dotted(value)}`);
  if ((plain?.addressClass === 'unicast') !== pub) return false;
  if ((mapped?.addressClass === 'unicast') !== pub) return false;
  return v4Spellings(value).every((spelling) => {
    const result = checkTarget(`http://${spelling}/`, POLICY);
    if (pub) return result.ok && result.value.literal?.address === dotted(value);
    return !result.ok && result.error.code === 'egress.address_denied';
  });
}

function v6Agrees(groups: readonly number[]): boolean {
  const pub = v6IsPublic(groups);
  return v6Spellings(groups).every((spelling) => {
    const verdict = classifyAddress(spelling);
    if ((verdict?.addressClass === 'unicast') !== pub) return false;
    const result = checkTarget(`http://[${spelling}]/`, POLICY);
    if (pub) return result.ok && result.value.literal?.family === 6;
    return !result.ok && result.error.code === 'egress.address_denied';
  });
}

// Whatever the input, the answer is a Result, and an accepted target is one an
// independent reading also accepts.
function urlSafe(url: string): boolean {
  const result = checkTarget(url, POLICY);
  if (!result.ok) return result.error.code.startsWith('egress.');
  const { host, literal } = result.value;
  if (literal !== undefined) return classifyAddress(literal.address)?.addressClass === 'unicast';
  return (
    host !== 'localhost' &&
    host.includes('.') &&
    !host.endsWith('.') &&
    !DENIED_SUFFIXES.some((suffix) => host.endsWith(suffix)) &&
    classifyAddress(host) === undefined
  );
}

export function fuzz({ seconds, seed, check }: FuzzOptions): FuzzReport {
  const property = fc.property(
    v4Arbitrary,
    v6Arbitrary,
    urlArbitrary,
    fc.string({ maxLength: 40, unit: 'binary' }),
    (v4, v6, url, junk) =>
      v4Agrees(v4) &&
      v6Agrees(v6) &&
      urlSafe(url) &&
      urlSafe(junk) &&
      urlSafe(`http://${junk}/`) &&
      (check === undefined || check(url)),
  );
  const details = fc.check(property, {
    seed,
    numRuns: Number.MAX_SAFE_INTEGER,
    interruptAfterTimeLimit: seconds * 1_000,
    markInterruptAsFailure: false,
    endOnFailure: true,
  });
  const failure = details.failed
    ? `seed ${String(details.seed)}, path ${details.counterexamplePath ?? 'unknown'}, input ${JSON.stringify(details.counterexample)}`
    : undefined;
  return { runs: details.numRuns, failure };
}
