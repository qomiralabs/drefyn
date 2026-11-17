import type { FlagClient } from '@drefyn/flags';
import type { TenantRef } from '@drefyn/tenancy';
import { Hono } from 'hono';
import { HostLookupError, type HostResolver, type SiteId } from './host.ts';
import type { DocsLogger, LogFields } from './log.ts';

export interface PublicSite {
  readonly tenant: TenantRef;
  readonly siteId: SiteId;
}

export interface DocsSiteDeps {
  readonly resolver: HostResolver;
  readonly flags: Pick<FlagClient, 'isOn'>;
  readonly logger: DocsLogger;
}

export interface DocsEnv {
  Variables: { site: PublicSite };
}

// One body for every miss, so a response never tells a missing site from a missing page or a
// site whose flag is off.
const plain = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });

const notFound = () => plain('Not found', 404);

export function createApp(deps: DocsSiteDeps): Hono<DocsEnv> {
  const { resolver, flags, logger } = deps;
  const app = new Hono<DocsEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    const done = (outcome: string, fields: LogFields = {}) => {
      logger.info('site.request', {
        outcome,
        ...fields,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - started),
      });
    };
    // Only the Host header CloudFront forwards. Forwarded and X-Forwarded-Host are never read,
    // and neither is the request URL, which an absolute form request target sets.
    const host = c.req.header('host') ?? '';
    let resolution;
    try {
      resolution = await resolver.resolveHost(host);
    } catch (error) {
      if (!(error instanceof HostLookupError)) throw error;
      c.res = plain('Service unavailable', 503, { 'retry-after': '5' });
      done('unavailable', { code: error.code });
      return;
    }
    if (resolution.kind === 'unknown') {
      c.res = notFound();
      done('unknown');
      return;
    }
    const { tenant, siteId } = resolution;
    const ids = {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      site_id: siteId,
    };
    if (!(await flags.isOn('docs.site', tenant))) {
      c.res = notFound();
      done('flag_off', ids);
      return;
    }
    // TODO(#353): private sites need the reader session before anything can serve them.
    if (resolution.access === 'private') {
      c.res = notFound();
      done('private', ids);
      return;
    }
    c.set('site', { tenant, siteId });
    await next();
    done('served', ids);
  });

  app.notFound(notFound);
  app.onError(() => {
    // The message can hold a host or a path, so only the event goes out.
    logger.error('site.request_failed');
    return plain('Internal error', 500);
  });

  return app;
}
