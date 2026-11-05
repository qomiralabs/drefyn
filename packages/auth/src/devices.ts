import type { AuthSchema, UserSchema } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { sha256 } from './keys.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import type { AuthLogger } from './rate-limiter.ts';
import { idFields, quietWarn, type SessionMethod, type SessionStore } from './session-support.ts';
import { SECRET_BYTES, decodeSecret, encodeSecret } from './tokens.ts';

// Browsers keep a cookie at most 400 days, so the cookie and its row live that long.
export const DEVICE_MAX_AGE_SECONDS = 400 * 86_400;
// Enough for a person's phones, laptops and browsers; past it the one seen longest ago goes.
export const DEVICES_PER_USER = 20;
// A device unseen this long counts as new again for the notice. The row itself stays for
// the full cookie lifetime, because it also keeps the device's own send allowance.
export const NEW_DEVICE_AFTER_DAYS = 90;
// A fixed number, so it can sit in the statement as a literal.
const NEW_DEVICE_INTERVAL = sql.raw(`interval '${String(NEW_DEVICE_AFTER_DAYS)} days'`);
// Where the notice sends people to end sessions.
export const SESSIONS_PAGE_PATH = '/account/sessions';
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

// A sign in from a device the person has not used in NEW_DEVICE_AFTER_DAYS.
export interface NewDevice {
  readonly device: string;
  // Database time of the sign in.
  readonly at: Date;
}

export interface RecordedDevice {
  readonly setCookies: readonly CookieSpec[];
  readonly newDevice: NewDevice | null;
}

// Records the browser a person just signed in from, hands it a device cookie if it had
// none, and says whether the device counts as new. Never fails the sign in: a device only
// relaxes a rate limit and decides a notice, so losing one costs the person nothing but that.
export async function recordDevice(
  config: AuthConfig,
  deps: DeviceDeps,
  b: BrowserContext,
  userId: UserId,
): Promise<RecordedDevice> {
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const held = deviceHash(config, b);
  const issued = held === null ? random(SECRET_BYTES) : null;
  const hash = held ?? sha256(issued ?? NO_DEVICE);
  const family = userAgentFamily(b.userAgent);
  let seen: { readonly fresh: boolean; readonly at: Date } | undefined;
  try {
    seen = await deps.store.user(userId, async (tx) => {
      // The row as it was before this write decides, in the same statement, so two sign ins
      // from one device at once send one notice.
      const row = await tx
        .insertInto('known_devices')
        .values({ user_id: userId, device_hash: hash, user_agent_family: family })
        .onConflict((c) =>
          c.columns(['user_id', 'device_hash']).doUpdateSet({
            last_seen_at: sql<Date>`now()`,
            user_agent_family: (e) => e.ref('excluded.user_agent_family'),
          }),
        )
        .returning([
          sql<boolean>`old.last_seen_at is null or old.last_seen_at < now() - ${NEW_DEVICE_INTERVAL}`.as(
            'fresh',
          ),
          sql<Date>`new.last_seen_at`.as('at'),
        ])
        .executeTakeFirst();
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
      return row;
    });
  } catch {
    quietWarn(deps.logger, 'auth.device_record_failed', idFields({ userId: ['usr', userId] }));
    return { setCookies: [], newDevice: null };
  }
  const newDevice = seen?.fresh === true ? { device: family, at: seen.at } : null;
  return { setCookies: issued === null ? [] : [deviceCookie(config, issued)], newDevice };
}

export interface NewDeviceNoticeInput {
  readonly to: string;
  readonly userId: UserId;
  readonly method: SessionMethod;
  readonly seen: NewDevice;
}

// The mail for a sign in from a new device. Never throws; meant to run after the response.
export function newDeviceNotice(
  config: AuthConfig,
  mailer: Partial<AuthNoticeMailer>,
  logger: AuthLogger,
  input: NewDeviceNoticeInput,
): () => Promise<void> {
  return async () => {
    try {
      const send = mailer.sendSecurityNotice;
      if (send === undefined) throw new Error('no notice mailer');
      await send.call(mailer, input.to, {
        kind: 'new_device_sign_in',
        method: input.method,
        device: input.seen.device,
        at: input.seen.at,
        sessionsLink: new URL(SESSIONS_PAGE_PATH, config.appOrigin),
      });
    } catch {
      quietWarn(logger, 'auth.device_notice_failed', idFields({ userId: ['usr', input.userId] }));
    }
  };
}

// Both sends, one after the other, for a sign in that owes more than one mail.
export function sendBoth(
  first: (() => Promise<void>) | undefined,
  second: (() => Promise<void>) | undefined,
): (() => Promise<void>) | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return async () => {
    await first();
    await second();
  };
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
