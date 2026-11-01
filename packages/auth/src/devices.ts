import type { AuthSchema, UserSchema } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { sha256 } from './keys.ts';
import type { AuthLogger } from './rate-limiter.ts';
import { idFields, quietWarn, type SessionStore } from './session-support.ts';
import { SECRET_BYTES, decodeSecret, encodeSecret } from './tokens.ts';

// Browsers keep a cookie at most 400 days, so the cookie and its row live that long.
export const DEVICE_MAX_AGE_SECONDS = 400 * 86_400;
// Enough for a person's phones, laptops and browsers; past it the one seen longest ago goes.
export const DEVICES_PER_USER = 20;
// Looked up when the browser has no device cookie, so the lookup always runs.
const NO_DEVICE = Buffer.alloc(32);
const NO_USER = '00000000-0000-0000-0000-000000000000';

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone|\biPad|\biPod/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const first = (ua: string, table: readonly (readonly [RegExp, string])[]) =>
  table.find(([pattern]) => pattern.test(ua))?.[1];

// A name from a short closed list, so the stored value says which kind of browser and
// nothing that tells one person's browser from another's.
export function userAgentFamily(userAgent: string): string {
  const ua = userAgent.slice(0, 512);
  const browser = first(ua, BROWSERS);
  if (browser === undefined) return 'Other';
  const system = first(ua, SYSTEMS);
  return system === undefined ? browser : `${browser} on ${system}`;
}

// The hash of the browser's device cookie, or null when it has none or a malformed one.
export function deviceHash(config: AuthConfig, b: BrowserContext): Buffer | null {
  const bytes = decodeSecret(b.cookies.get(config.cookies.device));
  return bytes === null ? null : sha256(bytes);
}

// Whether this browser's device is known for the user. One indexed select that runs for
// every send, known address or not, so its cost says nothing about the address.
export async function isKnownDevice(
  tx: Transaction<AuthSchema>,
  userId: UserId | null,
  hash: Buffer | null,
): Promise<boolean> {
  const row = await tx
    .selectFrom('known_devices')
    .select('user_id')
    .where('user_id', '=', userId ?? NO_USER)
    .where('device_hash', '=', hash ?? NO_DEVICE)
    .executeTakeFirst();
  return row !== undefined && userId !== null && hash !== null;
}

export interface DeviceDeps {
  readonly store: SessionStore;
  readonly logger: AuthLogger;
  readonly random?: (bytes: number) => Uint8Array;
}

// Records the browser a person just signed in from, and hands it a device cookie if it had
// none. Never fails the sign in: a device only ever relaxes a rate limit, so losing one
// costs the person nothing but that.
export async function recordDevice(
  config: AuthConfig,
  deps: DeviceDeps,
  b: BrowserContext,
  userId: UserId,
): Promise<readonly CookieSpec[]> {
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const held = deviceHash(config, b);
  const issued = held === null ? random(SECRET_BYTES) : null;
  const hash = held ?? sha256(issued ?? NO_DEVICE);
  try {
    await deps.store.user(userId, async (tx) => {
      await tx
        .insertInto('known_devices')
        .values({
          user_id: userId,
          device_hash: hash,
          user_agent_family: userAgentFamily(b.userAgent),
        })
        .onConflict((c) =>
          c.columns(['user_id', 'device_hash']).doUpdateSet({
            last_seen_at: sql<Date>`now()`,
            user_agent_family: (e) => e.ref('excluded.user_agent_family'),
          }),
        )
        .execute();
      // Keeps the newest by last_seen_at; the row just written is always among them.
      await tx
        .deleteFrom('known_devices')
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .where(
          'id',
          'not in',
          tx
            .selectFrom('known_devices')
            .select('id')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .orderBy('last_seen_at', 'desc')
            .orderBy('id', 'desc')
            .limit(DEVICES_PER_USER),
        )
        .execute();
    });
  } catch {
    quietWarn(deps.logger, 'auth.device_record_failed', idFields({ userId: ['usr', userId] }));
    return [];
  }
  if (issued === null) return [];
  return [deviceCookie(config, issued)];
}

const deviceCookie = (config: AuthConfig, secret: Uint8Array): CookieSpec => ({
  name: config.cookies.device,
  value: encodeSecret(secret),
  maxAgeSeconds: DEVICE_MAX_AGE_SECONDS,
});

// Every known device of the person goes, inside the caller's user transaction.
export async function forgetDevices(tx: Transaction<UserSchema>): Promise<void> {
  await tx
    .deleteFrom('known_devices')
    .where('user_id', '=', sql<string>`app.current_user_id()`)
    .execute();
}

// Forgets every device and gives this browser a new one, so a copied device cookie loses
// its exemption with the copied session. Inside the caller's user transaction.
export async function resetDevices(
  tx: Transaction<UserSchema>,
  config: AuthConfig,
  userId: UserId,
  userAgent: string,
  random: (bytes: number) => Uint8Array,
): Promise<readonly CookieSpec[]> {
  await forgetDevices(tx);
  const secret = random(SECRET_BYTES);
  await tx
    .insertInto('known_devices')
    .values({
      user_id: userId,
      device_hash: sha256(secret),
      user_agent_family: userAgentFamily(userAgent),
    })
    .execute();
  return [deviceCookie(config, secret)];
}
