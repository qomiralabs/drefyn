import type { FlagClient } from '@drefyn/flags';
import type { SiteDirectory } from '../src/index.ts';

export const ORG_A = '01900000-0000-7000-8000-00000000000a';
export const PRJ_A = '01900000-0000-7000-8000-0000000000aa';
export const SITE_A = '01900000-0000-7000-8000-000000000a5e';
export const ORG_B = '01900000-0000-7000-8000-00000000000b';
export const PRJ_B = '01900000-0000-7000-8000-0000000000bb';
export const SITE_B = '01900000-0000-7000-8000-000000000b5e';

export const DOMAINS = {
  hostSuffix: 'drefyn.test',
  reservedDomain: 'drefyn.test',
  dashboardHost: 'app.drefyn.dev',
} as const;

const VERIFIED = new Date('2026-11-01T00:00:00Z');

export interface FakeRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly access: 'public' | 'private';
}

export const rowA: FakeRow = {
  organizationId: ORG_A,
  projectId: PRJ_A,
  siteId: SITE_A,
  access: 'public',
};
export const rowB: FakeRow = {
  organizationId: ORG_B,
  projectId: PRJ_B,
  siteId: SITE_B,
  access: 'public',
};

export interface FakeDirectory extends SiteDirectory {
  readonly calls: string[];
}

// Two tenants: alpha.drefyn.test and docs.alpha.example for A, beta.drefyn.test and
// docs.beta.example for B. Custom domains in `pending` exist but were never verified, and
// those in `detached` were verified once and later lost.
export function fakeDirectory(
  options: {
    readonly subdomains?: Readonly<Record<string, FakeRow>>;
    readonly custom?: Readonly<Record<string, FakeRow>>;
    readonly pending?: Readonly<Record<string, FakeRow>>;
    readonly detached?: Readonly<Record<string, FakeRow>>;
  } = {},
): FakeDirectory {
  const subdomains = options.subdomains ?? { alpha: rowA, beta: rowB };
  const custom = options.custom ?? { 'docs.alpha.example': rowA, 'docs.beta.example': rowB };
  const pending = options.pending ?? { 'pending.alpha.example': rowA };
  const detached = options.detached ?? { 'old.beta.example': rowB };
  const calls: string[] = [];
  return {
    calls,
    bySubdomain(subdomain) {
      calls.push(`sub:${subdomain}`);
      const row = subdomains[subdomain];
      return Promise.resolve(row === undefined ? null : { subdomain, ...row });
    },
    byCustomDomain(domain) {
      calls.push(`custom:${domain}`);
      const live = custom[domain];
      if (live !== undefined) {
        return Promise.resolve({ domain, ...live, verifiedAt: VERIFIED, detachedAt: null });
      }
      const waiting = pending[domain];
      if (waiting !== undefined) {
        return Promise.resolve({ domain, ...waiting, verifiedAt: null, detachedAt: null });
      }
      const gone = detached[domain];
      if (gone !== undefined) {
        return Promise.resolve({
          domain,
          ...gone,
          verifiedAt: VERIFIED,
          detachedAt: new Date('2026-11-10T00:00:00Z'),
        });
      }
      return Promise.resolve(null);
    },
  };
}

export interface CapturedLog {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export function captureLogger() {
  const lines: CapturedLog[] = [];
  const push =
    (level: string) =>
    (event: string, fields: Readonly<Record<string, string | number | boolean>> = {}) => {
      lines.push({ level, event, fields });
    };
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

// The docs.site flag for named organizations only, as a targeted rollout would hold it.
export function flagsOnFor(...organizations: readonly string[]) {
  const asked: { name: string; organizationId: string; projectId?: string }[] = [];
  const client: Pick<FlagClient, 'isOn'> = {
    isOn: (name, ctx) => {
      asked.push({
        name,
        organizationId: ctx.organizationId,
        ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
      });
      return Promise.resolve(organizations.includes(ctx.organizationId));
    },
  };
  return { asked, client };
}
