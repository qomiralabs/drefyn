import {
  PASSWORD_FORM_MAX_BYTES,
  type AccessContext,
  type AccessView,
  type BrowserContext,
  type SessionInfo,
} from '@drefyn/auth';
import { z } from 'zod';
import { readClientAddress } from './client-address.ts';
import { originAllowed } from './origin.ts';

// Every signed out form is smaller than the password form, the largest of them.
export const PUBLIC_FORM_MAX_BYTES = PASSWORD_FORM_MAX_BYTES;

const USER_AGENT_MAX = 256;
const REFUSAL_LOG_INTERVAL_MS = 60_000;
const BINDING_FIELD = 'csrf';

export interface RequestFacts {
  readonly headers: Headers;
  readonly cookies: ReadonlyMap<string, string>;
}

export interface OrganizationGrant {
  readonly access: AccessContext;
  readonly view: AccessView;
}

export interface WrapperDeps {
  readonly appOrigin: () => string;
  // What an action sees of its request; a route has it on the request itself.
  readonly request: () => Promise<RequestFacts>;
  readonly wrapperRunning: () => boolean;
  readonly checkBinding: (browser: BrowserContext, field: string) => boolean;
  // Both redirect or answer 404 by throwing, which passes through the wrappers.
  readonly session: () => Promise<SessionInfo>;
  readonly organization: (slug: string) => Promise<OrganizationGrant>;
  readonly now: () => number;
  readonly logWarn: (event: string, context?: Record<string, string>) => void;
}

export interface Refusal {
  readonly ok: false;
  readonly status: 400 | 403 | 413 | 503;
  readonly code:
    | 'auth.origin_refused'
    | 'auth.client_ip_unresolved'
    | 'auth.challenge_binding'
    | 'auth.body_too_large'
    | 'auth.input_invalid';
}

export interface PublicContext {
  readonly browser: BrowserContext;
}
export interface SignedInContext extends PublicContext {
  readonly session: SessionInfo;
}
export interface OrganizationContext extends PublicContext, OrganizationGrant {}

// What a route wrapper needs of NextRequest.
export interface RouteRequest extends Request {
  readonly cookies: {
    getAll(): readonly { readonly name: string; readonly value: string }[];
  };
}
export interface OrganizationRouteContext {
  readonly params: Promise<{ readonly org: string }>;
}

const ORIGIN_REFUSED: Refusal = { ok: false, status: 403, code: 'auth.origin_refused' };
const ADDRESS_REFUSED: Refusal = { ok: false, status: 503, code: 'auth.client_ip_unresolved' };
const BINDING_REFUSED: Refusal = { ok: false, status: 403, code: 'auth.challenge_binding' };
const TOO_LARGE: Refusal = { ok: false, status: 413, code: 'auth.body_too_large' };
const SLUG_REFUSED: Refusal = { ok: false, status: 400, code: 'auth.input_invalid' };

const isRefusal = (value: BrowserContext | Refusal): value is Refusal => 'ok' in value;

function respond(refusal: Refusal): Response {
  return Response.json(
    { error: { code: refusal.code } },
    { status: refusal.status, headers: { 'cache-control': 'no-store' } },
  );
}

const encoder = new TextEncoder();

// Files never belong in a signed out form, and a size over the cap settles it either way.
function formBytes(form: FormData): number {
  let total = 0;
  for (const [name, value] of form) {
    total += encoder.encode(name).length;
    total += typeof value === 'string' ? encoder.encode(value).length : value.size;
  }
  return total;
}

const Slug = z.string();

// A flood of refusals must not become a flood of log lines.
function everyMinute(now: () => number): (write: () => void) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (write) => {
    if (now() - last < REFUSAL_LOG_INTERVAL_MS) return;
    last = now();
    write();
  };
}

// The only way to write a mutation. Actions answer a refusal as a value, because a Server
// Action cannot set its response status; routes answer the same refusal as a status. A
// handler runs only after every check above it passed.
export function createWrappers(deps: WrapperDeps) {
  const logOrigin = everyMinute(deps.now);
  const logAddress = everyMinute(deps.now);

  function admit({ headers, cookies }: RequestFacts): BrowserContext | Refusal {
    if (!originAllowed(headers, deps.appOrigin())) {
      logOrigin(() => {
        deps.logWarn('auth.origin_refused');
      });
      return ORIGIN_REFUSED;
    }
    const address = readClientAddress(headers, deps.wrapperRunning());
    if (!address.ok) {
      logAddress(() => {
        deps.logWarn('auth.client_ip_unresolved', { reason: address.reason });
      });
      return ADDRESS_REFUSED;
    }
    return {
      ip: address.ip,
      userAgent: (headers.get('user-agent') ?? '').slice(0, USER_AGENT_MAX),
      cookies,
    };
  }

  function formRefusal(browser: BrowserContext, form: unknown): Refusal | null {
    if (!(form instanceof FormData)) return BINDING_REFUSED;
    if (formBytes(form) > PUBLIC_FORM_MAX_BYTES) return TOO_LARGE;
    const field = form.get(BINDING_FIELD);
    if (typeof field !== 'string') return BINDING_REFUSED;
    return deps.checkBinding(browser, field) ? null : BINDING_REFUSED;
  }

  const factsOf = (request: RouteRequest): RequestFacts => ({
    headers: request.headers,
    cookies: new Map(request.cookies.getAll().map(({ name, value }) => [name, value])),
  });

  // Node stops reading at Content-Length, so a checked length bounds the read below. A body
  // with none is chunked, and no browser form is.
  async function readForm(request: RouteRequest): Promise<FormData | Refusal> {
    const length = Number(request.headers.get('content-length') ?? Number.NaN);
    if (!Number.isSafeInteger(length) || length > PUBLIC_FORM_MAX_BYTES) return TOO_LARGE;
    try {
      return await request.formData();
    } catch {
      return BINDING_REFUSED;
    }
  }

  return {
    publicAction<R>(handler: (context: PublicContext, form: FormData) => Promise<R>) {
      return async (form: FormData): Promise<R | Refusal> => {
        const browser = admit(await deps.request());
        if (isRefusal(browser)) return browser;
        const refused = formRefusal(browser, form);
        return refused ?? handler({ browser }, form);
      };
    },

    signedInAction<A extends unknown[], R>(
      handler: (context: SignedInContext, ...args: A) => Promise<R>,
    ) {
      return async (...args: A): Promise<R | Refusal> => {
        const browser = admit(await deps.request());
        if (isRefusal(browser)) return browser;
        return handler({ browser, session: await deps.session() }, ...args);
      };
    },

    orgAction<A extends unknown[], R>(
      handler: (context: OrganizationContext, ...args: A) => Promise<R>,
    ) {
      // The slug is a client argument. It selects nothing until the guard proves membership.
      return async (slug: string, ...args: A): Promise<R | Refusal> => {
        const browser = admit(await deps.request());
        if (isRefusal(browser)) return browser;
        const parsed = Slug.safeParse(slug);
        if (!parsed.success) return SLUG_REFUSED;
        return handler({ browser, ...(await deps.organization(parsed.data)) }, ...args);
      };
    },

    publicRoute(
      handler: (context: PublicContext, form: FormData, request: RouteRequest) => Promise<Response>,
    ) {
      return async (request: RouteRequest): Promise<Response> => {
        const browser = admit(factsOf(request));
        if (isRefusal(browser)) return respond(browser);
        const form = await readForm(request);
        if (!(form instanceof FormData)) return respond(form);
        const refused = formRefusal(browser, form);
        return refused === null ? handler({ browser }, form, request) : respond(refused);
      };
    },

    signedInRoute(handler: (context: SignedInContext, request: RouteRequest) => Promise<Response>) {
      return async (request: RouteRequest): Promise<Response> => {
        const browser = admit(factsOf(request));
        if (isRefusal(browser)) return respond(browser);
        return handler({ browser, session: await deps.session() }, request);
      };
    },

    orgRoute(handler: (context: OrganizationContext, request: RouteRequest) => Promise<Response>) {
      return async (request: RouteRequest, route: OrganizationRouteContext): Promise<Response> => {
        const browser = admit(factsOf(request));
        if (isRefusal(browser)) return respond(browser);
        const { org } = await route.params;
        return handler({ browser, ...(await deps.organization(org)) }, request);
      };
    },
  };
}
