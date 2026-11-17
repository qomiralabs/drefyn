import { randomUUID } from 'node:crypto';
import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterAll, inject } from 'vitest';
import { superuser, urlFor } from './stack.ts';

export const database = () => inject('githubDatabase');
export const admin = (text: string) => superuser(text, database());

// Pools a file opened, closed after it even when a test fails halfway.
export function pools() {
  const open: Database[] = [];
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDatabase(db).catch(() => undefined);
  });
  return async (): Promise<Database> => {
    const db = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', database()),
        DREFYN_DATABASE_SSL: 'disable',
      }),
    );
    open.push(db);
    return db;
  };
}

// A new organization with the given number of docs projects, so tests never share rows.
export async function seed(projects = 1): Promise<readonly TenantRef[]> {
  const organization = randomUUID();
  const ids = Array.from({ length: projects }, () => randomUUID());
  await admin(`
insert into app.organizations (organization_id, name, plan_tier)
  values ('${organization}', 'Org', 'self_hosted');
${ids
  .map(
    (id) => `insert into app.projects (id, organization_id, product, slug, name)
  values ('${id}', '${organization}', 'docs', 'p${id.slice(0, 8)}', 'Project');`,
  )
  .join('\n')}`);
  return ids.map((id) => ({
    organizationId: organizationId(organization),
    projectId: projectId(id),
  }));
}
