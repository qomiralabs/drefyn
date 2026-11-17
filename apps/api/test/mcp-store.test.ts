import type * as DbModule from '@drefyn/db';
import type { Database } from '@drefyn/db';
import { TIERS } from '@drefyn/entitlements';
import type { OrganizationId } from '@drefyn/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appMcpStore } from '../src/mcp.ts';
import { DOCS_PROJECT, ORG } from './support.ts';

interface Seen {
  readonly organizationId: OrganizationId;
  readonly wheres: [string, string, string][];
  readonly selected: unknown;
}

const seen: Seen[] = [];
let row: { product: string; plan_tier: string } | undefined;

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    withOrganization: (
      _db: unknown,
      org: { organizationId: OrganizationId },
      work: (tx: unknown) => Promise<unknown>,
    ) => {
      const wheres: [string, string, string][] = [];
      let selected: unknown;
      const chain = {
        selectFrom: () => chain,
        innerJoin: () => chain,
        select: (columns: unknown) => {
          selected = columns;
          return chain;
        },
        where: (column: string, op: string, value: string) => {
          wheres.push([column, op, value]);
          return chain;
        },
        executeTakeFirst: () => {
          seen.push({ organizationId: org.organizationId, wheres, selected });
          return Promise.resolve(row);
        },
      };
      return work(chain);
    },
  };
});

const store = appMcpStore(Object.freeze({}) as Database);
const tier = TIERS[0];

beforeEach(() => {
  seen.length = 0;
  row = undefined;
});

describe('appMcpStore', () => {
  it('reads the product and plan under the key organization, for that project only', async () => {
    row = { product: 'docs', plan_tier: tier };
    expect(await store.project(ORG, DOCS_PROJECT)).toEqual({ product: 'docs', tier });
    expect(seen).toEqual([
      {
        organizationId: ORG,
        selected: ['projects.product', 'organizations.plan_tier'],
        wheres: [
          ['projects.id', '=', DOCS_PROJECT],
          ['projects.organization_id', '=', ORG],
        ],
      },
    ]);
  });

  it('answers null for a project RLS does not show', async () => {
    expect(await store.project(ORG, DOCS_PROJECT)).toBeNull();
  });

  it('fails on a plan the table does not know', async () => {
    row = { product: 'docs', plan_tier: 'platinum' };
    await expect(store.project(ORG, DOCS_PROJECT)).rejects.toThrow('stored plan tier is unknown');
  });
});
