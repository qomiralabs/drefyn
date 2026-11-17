import type { AccessContext, ReachableProject } from '@drefyn/auth';
import type { EngineError, NodeLifecycle } from '@drefyn/engine';
import type { TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { dashboardData, type DashboardData } from './engine-holder.ts';
import { logWarn } from './log.ts';
import { findProject } from './projects.ts';

const PAGE_SIZE = 50;
// The engine's cursors are a few hundred bytes; anything far past that is not one of them.
const MAX_CURSOR = 1024;

export interface ListedPage {
  readonly id: string;
  readonly slug: string | null;
  readonly lifecycle: NodeLifecycle;
  // ISO 8601, so the page formats it and the read stays free of locale.
  readonly editedAt: string;
}

export type PagesCode = 'pages.invalid' | 'pages.not_found' | 'pages.busy' | 'pages.unavailable';

export type PagesRead =
  | { readonly ok: true; readonly pages: readonly ListedPage[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly code: PagesCode };

export interface PagesReadDeps {
  readonly data: () => Promise<Pick<DashboardData, 'store' | 'engine'>>;
  readonly findProject: (
    access: AccessContext,
    product: string,
    slug: string,
  ) => Promise<ReachableProject | undefined>;
}

// The cursor is the only thing a caller chooses. Organization and project come from the
// session and the reachable project, so a forged id is refused here and never reaches a query.
const Input = z.strictObject({ cursor: z.string().min(1).max(MAX_CURSOR).optional() });

const BUSY: ReadonlySet<string> = new Set([
  'engine.query_busy',
  'engine.write_busy',
  'engine.pool_busy',
]);

function codeOf(error: EngineError): PagesCode {
  if (error.code === 'engine.unavailable') {
    return error.issues.some((issue) => BUSY.has(issue.code)) ? 'pages.busy' : 'pages.unavailable';
  }
  // A cursor the engine does not recognise is the only input it can refuse here.
  if (error.code === 'engine.validation_failed') return 'pages.invalid';
  if (error.code === 'engine.not_found') return 'pages.not_found';
  return 'pages.unavailable';
}

const refuse = (code: PagesCode): PagesRead => ({ ok: false, code });

export function createPagesRead(deps: PagesReadDeps) {
  return async (access: AccessContext, projectSlug: string, input: unknown): Promise<PagesRead> => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) return refuse('pages.invalid');
    const project = await deps.findProject(access, 'docs', projectSlug);
    if (project === undefined) return refuse('pages.not_found');
    const tenant: TenantRef = {
      organizationId: access.organizationId,
      projectId: project.projectId,
    };
    try {
      const { store, engine } = await deps.data();
      // Docs keeps one page type per project. A project nobody has written in has none yet.
      const type = await store.tenant(tenant, (tx) =>
        tx
          .selectFrom('content_types')
          .select('id')
          .where('organization_id', '=', tenant.organizationId)
          .where('project_id', '=', tenant.projectId)
          .where('family', '=', 'docs_page')
          .where('key', '=', 'page')
          .executeTakeFirst(),
      );
      if (type === undefined) return { ok: true, pages: [], nextCursor: null };
      const { cursor } = parsed.data;
      const listed = await engine.queryNodes(tenant, {
        typeId: type.id,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!listed.ok) return refuse(codeOf(listed.error));
      return {
        ok: true,
        pages: listed.value.items.map((item) => ({
          id: item.nodeId,
          slug: item.slug,
          lifecycle: item.lifecycle,
          editedAt: item.updatedAt.toISOString(),
        })),
        nextCursor: listed.value.nextCursor,
      };
    } catch (error) {
      // The name only: a driver message can carry a host or a value.
      logWarn('dashboard.pages_read_failed', {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return refuse('pages.unavailable');
    }
  };
}

export const readDocsPages = createPagesRead({ data: dashboardData, findProject });
