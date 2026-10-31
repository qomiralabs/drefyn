import { beforeAll, expect, it } from 'vitest';
import { decodeSecret, sha256 } from '../../src/index.ts';
import {
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
});
