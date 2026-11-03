import * as crypto from 'node:crypto';
import { AuthError } from './errors.ts';
import { createHashGate, type HashGate } from './hash-gate.ts';
import { normalizePassword } from './password-input.ts';
import type { PasswordVerifier } from './step-up.ts';

export interface Argon2Params {
  readonly memoryKib: number;
  readonly passes: number;
  readonly parallelism: number;
}

// OWASP's minimum for Argon2id. Nothing below it is written or accepted.
export const ARGON2_FLOOR: Argon2Params = Object.freeze({
  memoryKib: 19_456,
  passes: 2,
  parallelism: 1,
});

// The most a stored string may ask for, so a bad row cannot make one verify cost minutes.
const ARGON2_CEILING: Argon2Params = Object.freeze({
  memoryKib: 262_144,
  passes: 10,
  parallelism: 4,
});

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const MIN_SALT_BYTES = 8;
const MIN_TAG_BYTES = 16;
const MAX_PART_BYTES = 64;
const VERSION = 19;
// Last hashes at the current parameters kept for the estimate of what one costs.
const ESTIMATE_SAMPLES = 31;
const WAIT_MS = 2_000;

export type Argon2Function = (
  algorithm: 'argon2id',
  parameters: {
    readonly message: Buffer;
    readonly nonce: Buffer;
    readonly parallelism: number;
    readonly tagLength: number;
    readonly memory: number;
    readonly passes: number;
  },
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void;

// Read at call time rather than imported by name: a Node without it must reach the startup
// check that names the problem, not fail to load this module.
export const builtInArgon2 = (): unknown => (crypto as Readonly<Record<string, unknown>>)['argon2'];

export interface ParsedPhc {
  readonly params: Argon2Params;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

// Standard base64 without padding, as PHC strings use.
// Cut to the unpadded length rather than strip with a pattern: no regex on stored input.
const b64 = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString('base64')
    .slice(0, Math.ceil((bytes.length * 4) / 3));

export function formatPhc(params: Argon2Params, salt: Uint8Array, tag: Uint8Array): string {
  return `$argon2id$v=${String(VERSION)}$m=${String(params.memoryKib)},t=${String(params.passes)},p=${String(params.parallelism)}$${b64(salt)}$${b64(tag)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=([1-9][0-9]{0,6}),t=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function part(text: string, min: number): Buffer | null {
  const bytes = Buffer.from(text, 'base64');
  // Re-encoding catches stray trailing bits, which would give one hash two spellings.
  if (b64(bytes) !== text || bytes.length < min || bytes.length > MAX_PART_BYTES) return null;
  return bytes;
}

// An argon2id v19 PHC string with parameters between the floor and the ceiling, or null.
// The floor is lowered only by tests.
export function parsePhc(phc: string, floor: Argon2Params = ARGON2_FLOOR): ParsedPhc | null {
  const match = PHC.exec(phc);
  if (match === null) return null;
  const params = {
    memoryKib: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  };
  const inRange = (key: keyof Argon2Params) =>
    params[key] >= floor[key] && params[key] <= ARGON2_CEILING[key];
  if (!inRange('memoryKib') || !inRange('passes') || !inRange('parallelism')) return null;
  // Argon2 needs 8 KiB of memory per lane.
  if (params.memoryKib < 8 * params.parallelism) return null;
  const salt = part(match[4] ?? '', MIN_SALT_BYTES);
  const tag = part(match[5] ?? '', MIN_TAG_BYTES);
  if (salt === null || tag === null) return null;
  return { params, salt, tag };
}

const sameParams = (a: Argon2Params, b: Argon2Params) =>
  a.memoryKib === b.memoryKib && a.passes === b.passes && a.parallelism === b.parallelism;

export interface PasswordCheck {
  readonly matched: boolean;
  // A right password stored at other parameters, or another salt or tag size.
  readonly rehash: boolean;
  // False when a stored string was there but could not be read.
  readonly readable: boolean;
}

export interface PasswordHasher extends PasswordVerifier {
  // A PHC string for the password at the configured parameters, with a fresh salt.
  hash(password: string): Promise<string>;
  // Checks a password against a stored PHC string, or against a dummy at the configured
  // parameters when there is none or it cannot be read, so every path costs one full hash.
  check(phc: string | null, password: string): Promise<PasswordCheck>;
}

export interface PasswordHasherOptions {
  readonly params: Argon2Params;
  readonly concurrency: number;
  readonly queueMax: number;
  readonly waitMs?: number;
  // Tests only: a lower floor so a test hash costs microseconds.
  readonly floor?: Argon2Params;
  readonly argon2?: Argon2Function;
  readonly random?: (bytes: number) => Uint8Array;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export function createPasswordHasher(options: PasswordHasherOptions): PasswordHasher {
  const { params } = options;
  const floor = options.floor ?? ARGON2_FLOOR;
  const argon2 = options.argon2 ?? (builtInArgon2() as Argon2Function);
  const random = options.random ?? ((n: number) => crypto.randomBytes(n));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => performance.now());
  const gate: HashGate = createHashGate({
    concurrency: options.concurrency,
    queueMax: options.queueMax,
    waitMs: options.waitMs ?? WAIT_MS,
  });
  const samples: number[] = [];
  let dummy: Promise<ParsedPhc> | null = null;

  // One Argon2id run through the gate. The password never reaches an error: a failure
  // becomes AUTH_UNAVAILABLE with no cause, since the cause could quote its input.
  async function derive(at: Argon2Params, message: Buffer, salt: Buffer, length: number) {
    return gate.run(async () => {
      const started = clock();
      const tag = await new Promise<Buffer | null>((resolve) => {
        try {
          argon2(
            'argon2id',
            {
              message,
              nonce: salt,
              parallelism: at.parallelism,
              tagLength: length,
              memory: at.memoryKib,
              passes: at.passes,
            },
            (error, key) => {
              resolve(error === null ? key : null);
            },
          );
        } catch {
          resolve(null);
        }
      });
      if (tag === null) throw new AuthError('AUTH_UNAVAILABLE', { retryAfterSeconds: 1 });
      if (sameParams(at, params)) {
        samples.push(clock() - started);
        if (samples.length > ESTIMATE_SAMPLES) samples.shift();
      }
      return tag;
    });
  }

  async function fresh(password: string): Promise<ParsedPhc> {
    const salt = Buffer.from(random(SALT_BYTES));
    const tag = await derive(params, Buffer.from(password, 'utf8'), salt, TAG_BYTES);
    return { params, salt, tag };
  }

  async function hashNormalized(password: string): Promise<string> {
    const made = await fresh(password);
    return formatPhc(made.params, made.salt, made.tag);
  }

  // Made once per process from a random password nobody knows, at the current parameters.
  function dummyHash(): Promise<ParsedPhc> {
    dummy ??= fresh(crypto.randomBytes(32).toString('hex')).catch((error: unknown) => {
      dummy = null;
      throw error;
    });
    return dummy;
  }

  async function matches(stored: ParsedPhc, password: string): Promise<boolean> {
    const tag = await derive(
      stored.params,
      Buffer.from(password, 'utf8'),
      stored.salt,
      stored.tag.length,
    );
    return crypto.timingSafeEqual(tag, stored.tag);
  }

  async function check(phc: string | null, raw: string): Promise<PasswordCheck> {
    const password = normalizePassword(raw);
    const stored = phc === null ? null : parsePhc(phc, floor);
    if (stored === null) {
      await matches(await dummyHash(), password);
      return { matched: false, rehash: false, readable: phc === null };
    }
    const current = sameParams(stored.params, params);
    const started = clock();
    const matched = await matches(stored, password);
    const elapsed = clock() - started;
    if (!matched && !current) {
      // A miss against an older hash would answer sooner than one against the current
      // parameters, and say the address has an account. It waits out the difference, or pays
      // for a dummy when there is nothing yet to estimate from.
      if (samples.length === 0) await matches(await dummyHash(), password);
      else {
        const pad = median(samples) - elapsed;
        if (pad > 0) await sleep(pad);
      }
    }
    const rehash =
      matched && (!current || stored.salt.length !== SALT_BYTES || stored.tag.length !== TAG_BYTES);
    return { matched, rehash, readable: true };
  }

  return Object.freeze({
    hash: async (password: string) => hashNormalized(normalizePassword(password)),
    check,
    verify: async (phc: string | null, password: string) => (await check(phc, password)).matched,
  });
}
