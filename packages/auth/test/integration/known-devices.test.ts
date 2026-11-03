import { AUTH_EXPIRY_RULES, deleteExpired, withAuth } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import { decodeSecret, sha256 } from '../../src/index.ts';
import {
  insideOneWindow,
  configWith,
  flowFor,
  newBrowser,
  requestCode,
  type Browser,
  type Flow,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

let n = 0;
const address = (label: string) => `${label}${String((n += 1))}@kd.example.com`;

async function signIn(flow: Flow, b: Browser, email: string, userAgent = FIREFOX_LINUX) {
  const start = await flow.signIn.startEmailSignIn(b.context({ userAgent }), { email });
  if (!start.ok) throw start.error;
  b.apply(start.value.setCookies);
  await start.value.send();
  const sent = flow.mail.sent.at(-1);
  if (sent?.to !== email) throw new Error('no mail');
  const result = await flow.signIn.verifyEmailCode(b.context({ userAgent }), { code: sent.code });
  if (!result.ok) throw result.error;
  b.apply(result.value.setCookies);
  return result.value;
}

const devicesOf = (email: string) =>
  h.sql(
    `select coalesce(string_agg(encode(d.device_hash, 'hex') || ':' || d.user_agent_family, ',' order by d.last_seen_at), '')
       from app.known_devices d join app.users u on u.id = d.user_id where u.email_normalized = '${email}';`,
  );

describeWithStack('known devices against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('a sign in sets a 400 day device cookie whose hash is recorded with the browser family', async () => {
    const flow = flowFor(h, configWith());
    const email = address('set');
    await h.user(email);
    const b = newBrowser();
    const signedIn = await signIn(flow, b, email);
    const cookie = signedIn.setCookies.find((c) => c.name === flow.config.cookies.device);
    expect(cookie?.maxAgeSeconds).toBe(400 * 86_400);
    const bytes = decodeSecret(cookie?.value);
    if (bytes === null) throw new Error('device cookie is not a 32 byte secret');
    expect(await devicesOf(email)).toBe(`${sha256(bytes).toString('hex')}:Firefox on Linux`);
  });

  it('a later sign in from the same browser keeps the cookie and the one row', async () => {
    const flow = flowFor(h, configWith());
    const email = address('keep');
    await h.user(email);
    const b = newBrowser();
    await signIn(flow, b, email);
    const value = b.cookies.get(flow.config.cookies.device);
    const second = await signIn(flow, b, email);
    expect(second.setCookies.some((c) => c.name === flow.config.cookies.device)).toBe(false);
    expect(b.cookies.get(flow.config.cookies.device)).toBe(value);
    expect((await devicesOf(email)).split(',')).toHaveLength(1);
  });

  it('keeps at most 20 devices per user, evicting the one seen longest ago', async () => {
    const flow = flowFor(h, configWith());
    const email = address('evict');
    await h.user(email);
    const browsers: Browser[] = [];
    for (let i = 0; i < 21; i += 1) {
      const b = newBrowser();
      browsers.push(b);
      await signIn(flow, b, email);
      // Spread last_seen_at apart so the oldest is unambiguous.
      await h.sql(
        `update app.known_devices set last_seen_at = last_seen_at - interval '1 minute';`,
      );
    }
    const rows = (await devicesOf(email)).split(',');
    expect(rows).toHaveLength(20);
    const firstValue = decodeSecret(browsers[0]?.cookies.get(flow.config.cookies.device));
    if (firstValue === null) throw new Error('no device cookie');
    expect(rows.some((r) => r.startsWith(sha256(firstValue).toString('hex')))).toBe(false);
  });

  it('a known device is never refused by the ceiling, and a fresh browser at the ceiling is', async () => {
    await insideOneWindow(h, 30);
    const flow = flowFor(
      h,
      configWith({
        DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '3/1d',
        DREFYN_AUTH_RATE_EMAIL_SEND_DEVICE: '10/1d',
      }),
    );
    const email = address('ceiling');
    await h.user(email);
    const own = newBrowser('2001:db8:1::1');
    await signIn(flow, own, email);
    for (let i = 0; i < 4; i += 1) {
      await flow.signIn.startEmailSignIn(newBrowser(`2001:db8:2:${String(i)}::1`).context(), {
        email,
      });
    }
    const stranger = await flow.signIn.startEmailSignIn(newBrowser('2001:db8:3::1').context(), {
      email,
    });
    expect(!stranger.ok && stranger.error.code).toBe('AUTH_RATE_LIMITED');
    const mail = await requestCode(flow, own, email);
    expect(mail).not.toBeNull();
  });

  it('a device cookie known for one person gives no exemption for another address', async () => {
    await insideOneWindow(h, 30);
    const flow = flowFor(h, configWith({ DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '2/1d' }));
    const mine = address('mine');
    const theirs = address('theirs');
    await h.user(mine);
    await h.user(theirs);
    const b = newBrowser('2001:db8:4::1');
    await signIn(flow, b, mine);
    for (let i = 0; i < 2; i += 1) {
      await flow.signIn.startEmailSignIn(newBrowser(`2001:db8:5:${String(i)}::1`).context(), {
        email: theirs,
      });
    }
    const result = await flow.signIn.startEmailSignIn(b.context(), { email: theirs });
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
  });

  it('signing out everywhere removes the person’s known devices', async () => {
    const flow = flowFor(h, configWith());
    const email = address('everywhere');
    await h.user(email);
    const b = newBrowser();
    const signedIn = await signIn(flow, b, email);
    await flow.sessions.signOutEverywhere(signedIn.session);
    expect(await devicesOf(email)).toBe('');
  });

  const noticesTo = (flow: Flow, email: string) =>
    flow.mail.notices.filter((m) => m.to === email && m.notice.kind === 'new_device_sign_in');

  it('a new device sends one notice, a repeat sends none, and 90 days unseen counts as new', async () => {
    const flow = flowFor(h, configWith());
    const email = address('notice');
    await h.user(email);
    // The first sign in of the account is from a device it has never seen.
    const b = newBrowser();
    const first = await signIn(flow, b, email);
    await first.send?.();
    expect(noticesTo(flow, email)).toHaveLength(1);
    const notice = noticesTo(flow, email)[0]?.notice;
    expect(notice).toMatchObject({
      kind: 'new_device_sign_in',
      method: 'email',
      device: 'Firefox on Linux',
    });
    const repeat = await signIn(flow, b, email);
    await repeat.send?.();
    expect(noticesTo(flow, email)).toHaveLength(1);
    // A device cookie this person has no row for counts as new too.
    const other = newBrowser();
    other.cookies.set(flow.config.cookies.device, b.cookies.get(flow.config.cookies.device) ?? '');
    await h.sql(
      `delete from app.known_devices d using app.users u where u.id = d.user_id and u.email_normalized = '${email}';`,
    );
    const unknownRow = await signIn(flow, other, email);
    await unknownRow.send?.();
    expect(noticesTo(flow, email)).toHaveLength(2);
    // Unseen for 91 days by database time: new again, and last_seen_at moves to now.
    await h.sql(
      `update app.known_devices d set last_seen_at = now() - interval '91 days' from app.users u where u.id = d.user_id and u.email_normalized = '${email}';`,
    );
    const stale = await signIn(flow, other, email);
    await stale.send?.();
    expect(noticesTo(flow, email)).toHaveLength(3);
    expect(
      await h.sql(
        `select bool_and(d.last_seen_at > now() - interval '1 minute') from app.known_devices d join app.users u on u.id = d.user_id where u.email_normalized = '${email}';`,
      ),
    ).toBe('t');
    // Seen 89 days ago is still known.
    await h.sql(
      `update app.known_devices d set last_seen_at = now() - interval '89 days' from app.users u where u.id = d.user_id and u.email_normalized = '${email}';`,
    );
    const recent = await signIn(flow, other, email);
    await recent.send?.();
    expect(noticesTo(flow, email)).toHaveLength(3);
  });

  it('a device last seen 91 days ago still skips the ceiling and survives the cleanup', async () => {
    await insideOneWindow(h, 30);
    const flow = flowFor(h, configWith({ DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '2/1d' }));
    const email = address('ninety');
    await h.user(email);
    const own = newBrowser('2001:db8:9::1');
    await signIn(flow, own, email);
    await h.sql(
      `update app.known_devices d set last_seen_at = now() - interval '91 days' from app.users u where u.id = d.user_id and u.email_normalized = '${email}';`,
    );
    await withAuth(h.authDb, (tx) => deleteExpired(tx, AUTH_EXPIRY_RULES));
    expect((await devicesOf(email)).split(',').filter(Boolean)).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      await flow.signIn.startEmailSignIn(newBrowser(`2001:db8:a:${String(i)}::1`).context(), {
        email,
      });
    }
    const mail = await requestCode(flow, own, email);
    expect(mail).not.toBeNull();
    // Past 400 days the cleanup takes it.
    await h.sql(
      `update app.known_devices d set last_seen_at = now() - interval '401 days' from app.users u where u.id = d.user_id and u.email_normalized = '${email}';`,
    );
    await withAuth(h.authDb, (tx) => deleteExpired(tx, AUTH_EXPIRY_RULES));
    expect(await devicesOf(email)).toBe('');
  });

  it('stores no raw user agent and no IP', async () => {
    const flow = flowFor(h, configWith());
    const email = address('row');
    await h.user(email);
    const ip = '198.51.100.201';
    const agent = `${FIREFOX_LINUX} UniqueMarker/7.7`;
    const b = newBrowser(ip);
    await signIn(flow, b, email, agent);
    const columns = await h.sql(
      `select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'app' and table_name = 'known_devices';`,
    );
    expect(columns).toBe('created_at,device_hash,id,last_seen_at,user_agent_family,user_id');
    const row = await h.sql(
      `select row_to_json(d)::text from app.known_devices d join app.users u on u.id = d.user_id where u.email_normalized = '${email}';`,
    );
    expect(row).not.toContain('UniqueMarker');
    expect(row).not.toContain(ip);
    expect(row).not.toContain('Mozilla');
    expect(row).toContain('"user_agent_family":"Firefox on Linux"');
  });
});
