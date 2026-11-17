import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AuthError } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const after = vi.fn();
const isOn = vi.fn<() => Promise<unknown>>();
const secondFactors = {
  startEnrollment: vi.fn(),
  confirmEnrollment: vi.fn(),
  replaceRecoveryCodes: vi.fn(),
};
const send = vi.fn(() => Promise.resolve());

vi.mock('next/server', () => ({ after }));
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ secondFactors }),
  authConfig: () => ({ cookieSecure: true, cookies: { device: '__Host-drefyn_device' } }),
}));
vi.mock('../src/server/flags.ts', () => ({ totpFlag: { isOn } }));
vi.mock('../src/server/origin.ts', () => ({ appUrl: (path: string) => new URL(path, ORIGIN) }));
vi.mock('../src/server/sign-in-support.ts', () => ({
  failureReference: () => 'ref_0a1b2c3d4e5f',
}));

const routes = await import('../src/server/factor-routes.ts');

const SESSION = { userId: 'usr_1', sessionId: 'ses_1', email: 'maya@acme.dev' };
const BROWSER = { ip: '203.0.113.9', userAgent: 'x', cookies: new Map() };
const CONTEXT = { browser: BROWSER, session: SESSION } as unknown as Parameters<
  typeof routes.startEnrolment
>[0];
type Route = Parameters<typeof routes.startEnrolment>[1];

const KEY = 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH';
const URI =
  'otpauth://totp/Drefyn:maya%40acme.dev?secret=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH&issuer=Drefyn&algorithm=SHA1&digits=6&period=30';
const CODES = Array.from({ length: 10 }, (_, i) => `k3m9q${String(i)}-7xw2ph-c8vn4t-r6yb0a`);

function post(fields: Record<string, string> = {}, length: 'right' | 'none' | 'huge' = 'right') {
  const body = new URLSearchParams(fields).toString();
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (length === 'right') headers.set('content-length', String(Buffer.byteLength(body)));
  if (length === 'huge') headers.set('content-length', '999999');
  const request = new Request(`${ORIGIN}/account/second-factor/x`, {
    method: 'POST',
    body,
    headers,
  });
  return Object.assign(request, { cookies: { getAll: () => [] } }) as unknown as Route;
}

const yes = <T>(value: T) => ({ ok: true, value });
const no = (code: ConstructorParameters<typeof AuthError>[0], detail = {}) => ({
  ok: false,
  error: new AuthError(code, detail),
});
const count = (text: string, part: string) => text.split(part).length - 1;

beforeEach(() => {
  vi.clearAllMocks();
  isOn.mockResolvedValue(true);
});

describe('the enrolment routes, before the library', () => {
  const each = [
    ['start', routes.startEnrolment, secondFactors.startEnrollment],
    ['confirm', routes.confirmEnrolment, secondFactors.confirmEnrollment],
    ['replace', routes.replaceCodes, secondFactors.replaceRecoveryCodes],
  ] as const;

  it.each(each)('%s answers 404 with the flag off, and calls nothing', async (_n, route, call) => {
    isOn.mockResolvedValue(false);
    const response = await route(CONTEXT, post({ code: '123456' }));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(call).not.toHaveBeenCalled();
  });

  it.each(each)('%s reads a failed flag as off', async (_n, route, call) => {
    isOn.mockRejectedValue(new Error('flagd'));
    expect((await route(CONTEXT, post())).status).toBe(404);
    expect(call).not.toHaveBeenCalled();
  });

  it('asks the flag about the signed in person', async () => {
    secondFactors.startEnrollment.mockResolvedValue(no('AUTH_UNAVAILABLE'));
    await routes.startEnrolment(CONTEXT, post());
    expect(isOn).toHaveBeenCalledWith('auth.totp', { userId: 'usr_1' });
  });

  it.each(each)(
    '%s refuses a body with no length, or one over the cap',
    async (_n, route, call) => {
      for (const length of ['none', 'huge'] as const) {
        const response = await route(CONTEXT, post({ code: '123456' }, length));
        expect(response.status).toBe(413);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(call).not.toHaveBeenCalled();
    },
  );
});

describe('POST start', () => {
  it('answers 200 with the page, the key and the QR path once each, and no URI', async () => {
    secondFactors.startEnrollment.mockResolvedValue(yes({ otpauthUri: URI, manualKey: KEY }));
    const response = await routes.startEnrolment(CONTEXT, post());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('location')).toBe(false);
    const body = await response.text();
    expect(count(body, KEY)).toBe(1);
    expect(count(body, '<path d="')).toBe(1);
    expect(body).not.toContain('otpauth');
    expect(body).not.toContain('AAAABBBBCCCC');
    expect(body).not.toMatch(/<script|__next_f|\sstyle=|type="hidden"/i);
    expect(secondFactors.startEnrollment).toHaveBeenCalledWith(BROWSER, SESSION);
  });

  // The person confirms it is them and comes back; nothing secret travels in the redirect.
  it('sends a stale step up back to settings to confirm, with a 303 and no body', async () => {
    secondFactors.startEnrollment.mockResolvedValue(no('AUTH_RECENT_AUTH_REQUIRED'));
    const response = await routes.startEnrolment(CONTEXT, post());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/account/sign-in?factor=confirm`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('answers 404 when the library says enrolment is off', async () => {
    secondFactors.startEnrollment.mockResolvedValue(no('AUTH_NOT_FOUND'));
    expect((await routes.startEnrolment(CONTEXT, post())).status).toBe(404);
  });
});

describe('POST confirm', () => {
  it('passes only the typed code', async () => {
    secondFactors.confirmEnrollment.mockResolvedValue(no('AUTH_FACTOR_INVALID'));
    await routes.confirmEnrolment(CONTEXT, post({ code: '123 456', secret: 'x' }));
    expect(secondFactors.confirmEnrollment).toHaveBeenCalledWith(BROWSER, SESSION, {
      code: '123 456',
    });
  });

  it('shows the same secret again after a mistyped code, with the error on the field', async () => {
    secondFactors.confirmEnrollment.mockResolvedValue(
      yes({ kind: 'mistyped', enrollment: { otpauthUri: URI, manualKey: KEY } }),
    );
    const response = await routes.confirmEnrolment(CONTEXT, post({ code: '000000' }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(count(body, KEY)).toBe(1);
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('id="code-error"');
    expect(body).not.toContain('000000');
    expect(after).not.toHaveBeenCalled();
  });

  it('shows each recovery code once, sets the device cookie and mails after the response', async () => {
    secondFactors.confirmEnrollment.mockResolvedValue(
      yes({
        kind: 'enrolled',
        recoveryCodes: CODES,
        setCookies: [{ name: '__Host-drefyn_device', value: 'd', maxAgeSeconds: 60 }],
        send,
      }),
    );
    const response = await routes.confirmEnrolment(CONTEXT, post({ code: '123456' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-drefyn_device=d; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax',
    ]);
    const body = await response.text();
    for (const code of CODES) expect(count(body, code)).toBe(1);
    expect(body).not.toMatch(/<script|__next_f|\sstyle=|<form|type="hidden"/i);
    expect(after).toHaveBeenCalledWith(send);
  });

  it.each([
    ['AUTH_RECENT_AUTH_REQUIRED', '/account/sign-in?factor=confirm'],
    ['AUTH_FACTOR_INVALID', '/account/sign-in?factor=wrong'],
    ['AUTH_FACTOR_CHALLENGE_EXPIRED', '/account/sign-in?factor=expired'],
    ['AUTH_FACTOR_ALREADY_ENROLLED', '/account/sign-in?factor=enrolled'],
    ['AUTH_UNAVAILABLE', '/account/sign-in?factor=failed&ref=ref_0a1b2c3d4e5f'],
    ['AUTH_SESSION_INVALID', '/sign-in'],
  ] as const)('sends %s to %s with nothing secret', async (code, path) => {
    secondFactors.confirmEnrollment.mockResolvedValue(no(code));
    const response = await routes.confirmEnrolment(CONTEXT, post({ code: '123456' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}${path}`);
    expect(await response.text()).toBe('');
  });

  it('says when to retry after a limit', async () => {
    secondFactors.confirmEnrollment.mockResolvedValue(
      no('AUTH_RATE_LIMITED', { retryAfterSeconds: 250 }),
    );
    const response = await routes.confirmEnrolment(CONTEXT, post({ code: '123456' }));
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/account/sign-in?factor=limited&retry=5`,
    );
  });
});

describe('POST replace', () => {
  it('takes a code of either kind and shows the new codes once', async () => {
    secondFactors.replaceRecoveryCodes.mockResolvedValue(
      yes({ recoveryCodes: CODES, setCookies: [], send }),
    );
    const response = await routes.replaceCodes(
      CONTEXT,
      post({ kind: 'recovery_code', code: 'abcdef' }),
    );
    expect(secondFactors.replaceRecoveryCodes).toHaveBeenCalledWith(BROWSER, SESSION, {
      kind: 'recovery_code',
      code: 'abcdef',
    });
    const body = await response.text();
    for (const code of CODES) expect(count(body, code)).toBe(1);
    expect(body).toContain('Your old ones stopped working');
    expect(body).not.toContain('abcdef');
    expect(after).toHaveBeenCalledWith(send);
  });

  it('reads any other kind as an authenticator code', async () => {
    secondFactors.replaceRecoveryCodes.mockResolvedValue(no('AUTH_FACTOR_INVALID'));
    await routes.replaceCodes(CONTEXT, post({ kind: 'sms', code: '123456' }));
    expect(secondFactors.replaceRecoveryCodes).toHaveBeenCalledWith(BROWSER, SESSION, {
      kind: 'totp',
      code: '123456',
    });
  });

  it.each([
    ['AUTH_FACTOR_INVALID', 'wrong'],
    ['AUTH_FACTOR_DISABLED', 'disabled'],
    ['AUTH_FACTOR_NOT_ENROLLED', 'not_enrolled'],
  ] as const)('sends %s back to settings as %s', async (code, word) => {
    secondFactors.replaceRecoveryCodes.mockResolvedValue(no(code));
    const response = await routes.replaceCodes(CONTEXT, post({ code: '123456' }));
    expect(response.headers.get('location')).toBe(`${ORIGIN}/account/sign-in?factor=${word}`);
  });
});

// Only these routes may return a secret or codes. A Server Action would write its returned
// state into the page payload, so no 'use server' module may reach the three calls.
describe('where the secret can come from', () => {
  const SRC = new URL('../src/', import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  const callers = files(SRC)
    .filter((path) =>
      /\.(startEnrollment|confirmEnrollment|replaceRecoveryCodes)\(/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    .map((path) => relative(SRC, path));

  it('is the route module alone', () => {
    expect(callers).toEqual(['server/factor-routes.ts']);
  });

  it('is no Server Action module', () => {
    const text = readFileSync(join(SRC, 'server/factor-routes.ts'), 'utf8');
    expect(text).not.toMatch(/^['"]use server['"]/m);
  });

  it.each(['start', 'confirm', 'replace'])('is a POST route at %s and nothing else', (name) => {
    const text = readFileSync(join(SRC, `app/account/second-factor/${name}/route.ts`), 'utf8');
    expect(text).toMatch(/export const POST = signedInRoute\(/);
    expect(text).not.toMatch(/export (const|async function|function) (GET|HEAD)\b/);
  });
});
