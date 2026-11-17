import { z } from 'zod';
import type { SiteDomains } from './host.ts';
import { isAtOrUnder, isHostname } from './hostname.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export type DocsSiteConfigKey =
  'DREFYN_APP_ORIGIN' | 'DREFYN_DOCS_HOST_SUFFIX' | 'DREFYN_DOCS_SITE_PORT';

// Names the key and why, never the value, which can be an internal host name.
export class DocsSiteConfigError extends Error {
  readonly key: DocsSiteConfigKey;
  constructor(key: DocsSiteConfigKey, reason: string) {
    super(`${key} ${reason}`);
    this.name = 'DocsSiteConfigError';
    this.key = key;
  }
}

export interface DocsSiteConfig {
  readonly domains: SiteDomains;
  readonly port: number;
}

export const HOSTED_HOST_SUFFIX = 'drefyn.app';
export const DEFAULT_PORT = 3002;

const PORT = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/)
  .transform(Number)
  .pipe(z.number().max(65_535));

function dashboardHost(raw: string | undefined): string {
  const key = 'DREFYN_APP_ORIGIN';
  if (raw === undefined) throw new DocsSiteConfigError(key, 'is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DocsSiteConfigError(key, 'must be an origin such as https://app.example.com');
  }
  const plain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    isHostname(url.hostname);
  if (!plain) {
    throw new DocsSiteConfigError(key, 'must be an origin such as https://app.example.com');
  }
  return url.hostname;
}

// A name with a parent of its own reserves that parent, so docs.example.org keeps
// example.org. A two label name has no parent we may claim and reserves only itself.
const reservedFor = (suffix: string): string => {
  const labels = suffix.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : suffix;
};

export function parseDocsSiteConfig(env: Env): DocsSiteConfig {
  const dashboard = dashboardHost(env['DREFYN_APP_ORIGIN']);

  const key = 'DREFYN_DOCS_HOST_SUFFIX';
  const raw = env[key] ?? (env['DREFYN_HOSTED'] === 'true' ? HOSTED_HOST_SUFFIX : undefined);
  if (raw === undefined) throw new DocsSiteConfigError(key, 'is required when self hosting');
  const suffix = raw.toLowerCase();
  if (!isHostname(suffix) || !suffix.includes('.')) {
    throw new DocsSiteConfigError(key, 'must be a domain name such as docs.example.com');
  }
  const reserved = reservedFor(suffix);
  // A site on a name that shares the dashboard's host, or sits above or below it, could set
  // or read cookies the dashboard relies on.
  if (isAtOrUnder(dashboard, reserved) || isAtOrUnder(suffix, dashboard)) {
    throw new DocsSiteConfigError(
      key,
      'must not equal, contain or sit under the dashboard host; use a separate domain',
    );
  }

  const port = PORT.safeParse(env['DREFYN_DOCS_SITE_PORT'] ?? String(DEFAULT_PORT));
  if (!port.success) {
    throw new DocsSiteConfigError('DREFYN_DOCS_SITE_PORT', 'must be a port from 1 to 65535');
  }

  return {
    domains: { hostSuffix: suffix, reservedDomain: reserved, dashboardHost: dashboard },
    port: port.data,
  };
}
