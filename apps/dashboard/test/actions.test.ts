import type { AccessContext, AccessView, BrowserContext, SessionInfo } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWrappers,
  PUBLIC_FORM_MAX_BYTES,
  type OrganizationGrant,
  type RequestFacts,
  type WrapperDeps,
} from '../src/server/action-wrappers.ts';
import { readClientAddress } from '../src/server/client-address.ts';

const ORIGIN = 'https://app.drefyn.test';
const NOT_A_FORM: unknown = 'text';
const IP = '203.0.113.9';
const GOOD = { origin: ORIGIN, 'x-forwarded-for': IP, 'user-agent': 'Firefox' };
const SESSION = { sessionId: 'ses_1', userId: 'usr_1' } as unknown as SessionInfo;
const GRANT: OrganizationGrant = {
  access: { organizationId: 'org_1' } as unknown as AccessContext,
  view: { organizationSlug: 'acme' } as unknown as AccessView,
};

let now: number;
let lines: Record<string, unknown>[];
let facts: RequestFacts;
let checkBinding: ReturnType<typeof vi.fn<WrapperDeps['checkBinding']>>;
let session: ReturnType<typeof vi.fn<WrapperDeps['session']>>;
let organization: ReturnType<typeof vi.fn<WrapperDeps['organization']>>;
let running: boolean;
let visitorFlag: ReturnType<typeof vi.fn<WrapperDeps['visitorFlag']>>;

const factsFor = (headers: Record<string, string>, cookies: [string, string][] = []) => ({
  headers: new Headers(headers),
  cookies: new Map(cookies),
});

function wrappers() {
  return createWrappers({
    appOrigin: () => ORIGIN,
    request: () => Promise.resolve(facts),
    wrapperRunning: () => running,
    visitorFlag,
    checkBinding,
    session,
    organization,
    now: () => now,
    logWarn: (event, context) => {
      lines.push({ event, ...context });
    },
  });
}

beforeEach(() => {
  now = 1_000_000;
  lines = [];
  running = true;
  visitorFlag = vi.fn<WrapperDeps['visitorFlag']>().mockResolvedValue(undefined);
  facts = factsFor(GOOD);
  checkBinding = vi.fn<WrapperDeps['checkBinding']>().mockReturnValue(true);
  session = vi.fn<WrapperDeps['session']>().mockResolvedValue(SESSION);
  organization = vi.fn<WrapperDeps['organization']>().mockResolvedValue(GRANT);
});

function form(fields: Record<string, string> = { csrf: 'field' }): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const post = (headers: Record<string, string>, body = form()) =>
  new Request(`${ORIGIN}/x`, { method: 'POST', headers, body: new URLSearchParams(body as never) });

// The one part of NextRequest a plain Request lacks.
const withCookies = (request: Request) =>
  Object.assign(request, { cookies: { getAll: () => [{ name: 'drefyn_pre', value: 'abc' }] } });

const FORBIDDEN = { ok: false, status: 403, code: 'auth.origin_refused' };
const UNRESOLVED = { ok: false, status: 503, code: 'auth.client_ip_unresolved' };

// Every wrapper, run through one shape, so each rule is proved on all six.
function everyWrapper(handler: () => Promise<string>) {
  const w = wrappers();
  const action = (run: () => Promise<unknown>) => async () => run();
  const route = async (run: () => Promise<Response>) => {
    const response = await run();
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const json = () => Response.json({ done: true });
  const params = { params: Promise.resolve({ org: 'acme' }) };
  return {
    publicAction: action(() => w.publicAction(handler)(form())),
    signedInAction: action(() => w.signedInAction(handler)()),
    orgAction: action(() => w.orgAction(handler)('acme')),
    publicRoute: (headers: Record<string, string>) =>
      route(() =>
        w.publicRoute(() => handler().then(json))(
          withCookies(post({ ...headers, 'content-length': '10' })),
        ),
      ),
    signedInRoute: (headers: Record<string, string>) =>
      route(() => w.signedInRoute(() => handler().then(json))(withCookies(post(headers)))),
    orgRoute: (headers: Record<string, string>) =>
      route(() => w.orgRoute(() => handler().then(json))(withCookies(post(headers)), params)),
  };
}

const BAD_ORIGINS: readonly (readonly [string, Record<string, string>])[] = [
  ['a missing Origin', { 'x-forwarded-for': IP }],
  ['a foreign Origin', { origin: 'https://evil.test', 'x-forwarded-for': IP }],
  ['Sec-Fetch-Site cross-site', { ...GOOD, 'sec-fetch-site': 'cross-site' }],
];

const ACTIONS = ['publicAction', 'signedInAction', 'orgAction'] as const;
const ROUTES = ['publicRoute', 'signedInRoute', 'orgRoute'] as const;

describe.each(BAD_ORIGINS)('%s', (_name, headers) => {
  it.each(ACTIONS)('is refused by %s with 403', async (name) => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    facts = factsFor(headers);
    await expect(everyWrapper(handler)[name]()).resolves.toEqual(FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(organization).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('is refused by %s with 403', async (name) => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(everyWrapper(handler)[name](headers)).resolves.toEqual({
      status: 403,
      body: { error: { code: 'auth.origin_refused' } },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('with the release flag off', () => {
  const OFF = new Error('NEXT_NOT_FOUND');
  beforeEach(() => {
    visitorFlag.mockRejectedValue(OFF);
  });

  it.each(ACTIONS)('%s is the 404, whatever the request', async (name) => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    facts = factsFor({});
    await expect(everyWrapper(handler)[name]()).rejects.toBe(OFF);
    expect(handler).not.toHaveBeenCalled();
    expect(checkBinding).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it.each(ROUTES)('%s is the 404, not a 403 or a 503', async (name) => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(everyWrapper(handler)[name]({})).rejects.toBe(OFF);
    expect(handler).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('stops a form bound before a rollback', async () => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().publicAction(handler)(form())).rejects.toBe(OFF);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the flag comes first', () => {
  it.each(ACTIONS)('%s asks it before reading the request', async (name) => {
    const request = vi.fn(() => Promise.resolve(facts));
    const w = createWrappers({
      appOrigin: () => ORIGIN,
      request,
      wrapperRunning: () => true,
      visitorFlag,
      checkBinding,
      session,
      organization,
      now: () => now,
      logWarn: () => undefined,
    });
    const run = {
      publicAction: () => w.publicAction(() => Promise.resolve('ran'))(form()),
      signedInAction: () => w.signedInAction(() => Promise.resolve('ran'))(),
      orgAction: () => w.orgAction(() => Promise.resolve('ran'))('acme'),
    }[name];
    await run();
    expect(visitorFlag.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe('the client address', () => {
  it.each([
    ['203.0.113.9'],
    ['2001:db8::1'],
    ['::ffff:203.0.113.9'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001'],
  ])('passes %s to BrowserContext unchanged', async (ip) => {
    facts = factsFor({ ...GOOD, 'x-forwarded-for': ip });
    let seen: BrowserContext | undefined;
    await wrappers().signedInAction((context) => {
      seen = context.browser;
      return Promise.resolve('ran');
    })();
    expect(seen?.ip).toBe(ip);
  });

  it.each([
    ['missing', { origin: ORIGIN }],
    ['list', { origin: ORIGIN, 'x-forwarded-for': `${IP}, 198.51.100.1` }],
    ['list', { origin: ORIGIN, 'x-forwarded-for': `${IP},${IP}` }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': 'unknown' }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': '' }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': `${IP}:443` }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': `[2001:db8::1]` }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': 'fe80::1%eth0' }],
    ['unparsable', { origin: ORIGIN, 'x-forwarded-for': '010.0.0.1' }],
  ])('refuses with 503 and logs reason %s', async (reason, headers) => {
    facts = factsFor(headers);
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().signedInAction(handler)()).resolves.toEqual(UNRESOLVED);
    expect(handler).not.toHaveBeenCalled();
    expect(lines).toEqual([
      expect.objectContaining({ event: 'auth.client_ip_unresolved', reason }),
    ]);
  });

  it('refuses a valid literal when the wrapper is not running, before the handler', async () => {
    running = false;
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().publicAction(handler)(form())).resolves.toEqual(UNRESOLVED);
    await expect(wrappers().signedInAction(handler)()).resolves.toEqual(UNRESOLVED);
    await expect(wrappers().orgAction(handler)('acme')).resolves.toEqual(UNRESOLVED);
    expect(handler).not.toHaveBeenCalled();
    expect(organization).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ event: 'auth.client_ip_unresolved', reason: 'no_wrapper' });
  });

  it('logs at most once a minute, across reasons, and never the value', async () => {
    const w = wrappers();
    const run = w.signedInAction(() => Promise.resolve('ran'));
    facts = factsFor({ origin: ORIGIN, 'x-forwarded-for': 'secret-value' });
    await run();
    await run();
    now += 59_999;
    facts = factsFor({ origin: ORIGIN });
    await run();
    expect(lines).toHaveLength(1);
    now += 1;
    await run();
    expect(lines.map((line) => line['reason'])).toEqual(['unparsable', 'missing']);
    expect(JSON.stringify(lines)).not.toContain('secret-value');
  });

  it.each([
    ['forwarded', 'for=198.51.100.1'],
    ['x-real-ip', '198.51.100.1'],
    ['true-client-ip', '198.51.100.1'],
    ['cf-connecting-ip', '198.51.100.1'],
    ['x-client-ip', '198.51.100.1'],
  ])('ignores %s when X-Forwarded-For is missing', async (name, value) => {
    facts = factsFor({ origin: ORIGIN, [name]: value });
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().signedInAction(handler)()).resolves.toEqual(UNRESOLVED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads only the one header', () => {
    const get = vi.fn(() => IP);
    expect(readClientAddress({ get }, true)).toEqual({ ok: true, ip: IP });
    expect(get.mock.calls).toEqual([['x-forwarded-for']]);
  });
});

describe('publicAction', () => {
  it('hands over the browser and the form once the binding holds', async () => {
    facts = factsFor(GOOD, [['drefyn_pre', 'abc']]);
    const data = form();
    let seen: { browser: BrowserContext; form: FormData } | undefined;
    const result = await wrappers().publicAction((context, submitted) => {
      seen = { browser: context.browser, form: submitted };
      return Promise.resolve('ran');
    })(data);
    expect(result).toBe('ran');
    expect(seen?.form).toBe(data);
    expect(seen?.browser.userAgent).toBe('Firefox');
    expect(seen?.browser.cookies.get('drefyn_pre')).toBe('abc');
    expect(checkBinding).toHaveBeenCalledWith(seen?.browser, 'field');
  });

  it('truncates the user agent to 256 characters', async () => {
    facts = factsFor({ ...GOOD, 'user-agent': 'x'.repeat(300) });
    let length = 0;
    await wrappers().publicAction(({ browser }) => {
      length = browser.userAgent.length;
      return Promise.resolve('ran');
    })(form());
    expect(length).toBe(256);
  });

  it.each([
    ['a wrong field', form({ csrf: 'forged' }), false],
    ['no field', form({}), true],
    ['a file for the field', fileForm(), true],
  ])('refuses %s', async (_name, data, bindingCheckSkipped) => {
    checkBinding.mockReturnValue(false);
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().publicAction(handler)(data)).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'auth.challenge_binding',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(checkBinding.mock.calls.length === 0).toBe(bindingCheckSkipped);
  });

  it('refuses something that is not a form', async () => {
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().publicAction(handler)(NOT_A_FORM as FormData)).resolves.toMatchObject({
      status: 403,
      code: 'auth.challenge_binding',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a form over the cap before the binding', async () => {
    const big = form({ csrf: 'field', other: 'x'.repeat(PUBLIC_FORM_MAX_BYTES) });
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().publicAction(handler)(big)).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'auth.body_too_large',
    });
    expect(checkBinding).not.toHaveBeenCalled();
  });

  it('counts bytes, not characters', async () => {
    const big = form({ csrf: 'field', other: '\u{1F600}'.repeat(PUBLIC_FORM_MAX_BYTES / 3) });
    await expect(wrappers().publicAction(() => Promise.resolve('ran'))(big)).resolves.toMatchObject(
      { status: 413 },
    );
  });

  it('runs no session lookup: it is for signed out forms', async () => {
    await wrappers().publicAction(() => Promise.resolve('ran'))(form());
    expect(session).not.toHaveBeenCalled();
    expect(organization).not.toHaveBeenCalled();
  });
});

function fileForm(): FormData {
  const data = new FormData();
  data.set('csrf', new File(['x'], 'x.txt'));
  return data;
}

describe('signedInAction', () => {
  it('passes the session and the arguments to the handler', async () => {
    const handler = vi.fn((context: { session: SessionInfo }, a: number, b: string) =>
      Promise.resolve(`${context.session.sessionId}${a}${b}`),
    );
    await expect(wrappers().signedInAction(handler)(1, 'x')).resolves.toBe('ses_11x');
  });

  it('lets a redirect from the session check pass through', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    session.mockRejectedValue(redirect);
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().signedInAction(handler)()).rejects.toBe(redirect);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('orgAction', () => {
  it('runs the guard with the slug it was called with, before the handler', async () => {
    const order: string[] = [];
    organization.mockImplementation(() => {
      order.push('guard');
      return Promise.resolve(GRANT);
    });
    const result = await wrappers().orgAction((context, a: number) => {
      order.push('handler');
      return Promise.resolve([context.access, context.view, a]);
    })('acme', 7);
    expect(organization).toHaveBeenCalledWith('acme');
    expect(order).toEqual(['guard', 'handler']);
    expect(result).toEqual([GRANT.access, GRANT.view, 7]);
  });

  it('never runs the handler when the guard says no', async () => {
    const notFound = new Error('NEXT_NOT_FOUND');
    organization.mockRejectedValue(notFound);
    const handler = vi.fn(() => Promise.resolve('ran'));
    await expect(wrappers().orgAction(handler)('acme')).rejects.toBe(notFound);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([[1], [null], [undefined], [['acme']], [{}]])(
    'refuses a slug of %j before the guard',
    async (slug) => {
      const handler = vi.fn(() => Promise.resolve('ran'));
      await expect(wrappers().orgAction(handler)(slug as never)).resolves.toEqual({
        ok: false,
        status: 400,
        code: 'auth.input_invalid',
      });
      expect(organization).not.toHaveBeenCalled();
    },
  );
});

describe('the route versions', () => {
  const cookieRequest = (headers: Record<string, string>) => withCookies(post(headers));

  it('publicRoute checks the binding, then passes the parsed form and the request', async () => {
    let seen: { browser: BrowserContext; form: FormData; request: Request } | undefined;
    const request = cookieRequest({ ...GOOD, 'content-length': '10' });
    const response = await wrappers().publicRoute((context, submitted, incoming) => {
      seen = { browser: context.browser, form: submitted, request: incoming };
      return Promise.resolve(new Response('ok'));
    })(request);
    expect(response.status).toBe(200);
    expect(seen?.form.get('csrf')).toBe('field');
    expect(seen?.browser.ip).toBe(IP);
    expect(seen?.browser.cookies.get('drefyn_pre')).toBe('abc');
    expect(seen?.request).toBe(request);
  });

  it('never caches a refusal', async () => {
    const response = await wrappers().signedInRoute(() => Promise.resolve(new Response('ok')))(
      cookieRequest({}),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('publicRoute refuses a forged field with 403', async () => {
    checkBinding.mockReturnValue(false);
    const handler = vi.fn(() => Promise.resolve(new Response('ok')));
    const response = await wrappers().publicRoute(handler)(
      cookieRequest({ ...GOOD, 'content-length': '10' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'auth.challenge_binding' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['no length', {}],
    ['too long', { 'content-length': String(PUBLIC_FORM_MAX_BYTES + 1) }],
    ['not a number', { 'content-length': 'many' }],
  ])('publicRoute refuses a body with %s before reading it', async (_name, extra) => {
    const handler = vi.fn(() => Promise.resolve(new Response('ok')));
    const request = cookieRequest({ ...GOOD, ...extra });
    const read = vi.spyOn(request, 'formData');
    const response = await wrappers().publicRoute(handler)(request);
    expect(response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it('publicRoute refuses a body that is not a form', async () => {
    const request = Object.assign(
      new Request(`${ORIGIN}/x`, {
        method: 'POST',
        headers: { ...GOOD, 'content-length': '2', 'content-type': 'application/json' },
        body: '{}',
      }),
      { cookies: { getAll: () => [] } },
    );
    const response = await wrappers().publicRoute(() => Promise.resolve(new Response('ok')))(
      request,
    );
    expect(response.status).toBe(403);
  });

  it('signedInRoute passes the session', async () => {
    const response = await wrappers().signedInRoute((context) =>
      Promise.resolve(new Response(context.session.sessionId)),
    )(cookieRequest(GOOD));
    expect(await response.text()).toBe('ses_1');
  });

  it('orgRoute guards the slug from the route', async () => {
    const response = await wrappers().orgRoute((context) =>
      Promise.resolve(new Response(context.view.organizationSlug)),
    )(cookieRequest(GOOD), { params: Promise.resolve({ org: 'acme' }) });
    expect(await response.text()).toBe('acme');
    expect(organization).toHaveBeenCalledWith('acme');
  });

  it('a route answers 503 when the address cannot be read', async () => {
    const response = await wrappers().orgRoute(() => Promise.resolve(new Response('ok')))(
      cookieRequest({ origin: ORIGIN }),
      { params: Promise.resolve({ org: 'acme' }) },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'auth.client_ip_unresolved' } });
  });
});

describe('refusal logs', () => {
  it('logs a refused origin once a minute without the value', async () => {
    const w = wrappers();
    const run = w.signedInAction(() => Promise.resolve('ran'));
    facts = factsFor({ origin: 'https://evil.test' });
    await run();
    await run();
    expect(lines).toEqual([{ event: 'auth.origin_refused' }]);
    now += 60_000;
    await run();
    expect(lines).toHaveLength(2);
  });
});

describe('publicAction under useActionState', () => {
  beforeEach(() => {
    facts = factsFor(GOOD);
    checkBinding.mockReturnValue(true);
  });

  const form = () => {
    const body = new FormData();
    body.set('csrf', 'x'.repeat(43));
    return body;
  };

  it('takes the previous state first and hands the handler only the form', async () => {
    const handler = vi.fn<(c: unknown, f: FormData) => Promise<string>>(() =>
      Promise.resolve('done'),
    );
    const action = wrappers().publicAction(handler);
    const body = form();
    await expect(action({ earlier: 'state' }, body)).resolves.toBe('done');
    expect(handler.mock.calls[0]?.[1]).toBe(body);
  });

  it('still takes a form alone', async () => {
    const action = wrappers().publicAction(() => Promise.resolve('done'));
    await expect(action(form())).resolves.toBe('done');
  });

  it('refuses when the last argument is not a form, whatever came before it', async () => {
    const handler = vi.fn(() => Promise.resolve('done'));
    const action = wrappers().publicAction(handler);
    const forged = form();
    await expect(action(forged, 'not a form' as unknown as FormData)).resolves.toMatchObject({
      ok: false,
      code: 'auth.challenge_binding',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
