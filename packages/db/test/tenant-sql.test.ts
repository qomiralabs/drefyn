import { describe, expect, it } from 'vitest';
import { publishedTableSql, tenantTableSql, type TenantTableSpec } from '../src/tenant-sql.ts';
import { thrown } from './support.ts';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').toLowerCase();

const notes: TenantTableSpec = {
  name: 'notes',
  scope: 'project',
  columns: ['body text not null'],
};

describe('tenantTableSql for a project scoped table', () => {
  const sql = () => squash(tenantTableSql(notes));

  it('creates the table in app with both tenant columns not null', () => {
    expect(sql()).toContain('create table app.notes');
    expect(sql()).toMatch(/organization_id uuid not null/);
    expect(sql()).toMatch(/project_id uuid not null/);
    expect(sql()).toContain('body text not null');
    expect(sql()).toMatch(/timestamptz/);
    expect(sql()).not.toMatch(/\btimestamp\b(?! with time zone)/);
  });

  it('ties the row to a project of the same organization', () => {
    expect(sql()).toMatch(
      /foreign key \(organization_id, project_id\) references app\.projects \(organization_id, id\)/,
    );
  });

  it('can point the foreign key at another projects table', () => {
    expect(squash(tenantTableSql({ ...notes, projectsTable: 'fixture_projects' }))).toMatch(
      /references app\.fixture_projects \(organization_id, id\)/,
    );
  });

  it('adds an index that leads with organization_id', () => {
    expect(sql()).toMatch(/create index \S* ?on app\.notes \(organization_id, project_id/);
  });

  it('enables and forces row level security', () => {
    expect(sql()).toContain('alter table app.notes enable row level security');
    expect(sql()).toContain('alter table app.notes force row level security');
  });

  it('adds the tenant_isolation policy reading both settings in using and with check', () => {
    const policy = /create policy tenant_isolation on app\.notes(.*?)(;|$)/.exec(sql())?.[1] ?? '';
    expect(policy).toMatch(/using \(/);
    expect(policy).toMatch(/with check \(/);
    expect(policy.match(/app\.current_org\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(policy.match(/app\.current_project\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('never grants to the reader and never touches default privileges', () => {
    expect(sql()).not.toContain('drefyn_public_reader');
    expect(sql()).not.toContain('default privileges');
  });
});

describe('tenantTableSql for an organization scoped table', () => {
  const sql = () =>
    squash(
      tenantTableSql({ name: 'members', scope: 'organization', columns: ['email text not null'] }),
    );

  it('has organization_id and no project column, key or clause', () => {
    expect(sql()).toMatch(/organization_id uuid not null/);
    expect(sql()).not.toContain('project_id');
    expect(sql()).not.toContain('current_project');
    expect(sql()).not.toContain('references app.projects');
  });

  it('still forces row level security with the policy', () => {
    expect(sql()).toContain('force row level security');
    expect(sql()).toContain('create policy tenant_isolation on app.members');
  });
});

describe('publishedTableSql', () => {
  const sql = () =>
    squash(publishedTableSql({ name: 'published_pages', columns: ['body text not null'] }));

  it('is a project scoped tenant table', () => {
    expect(sql()).toContain('create table app.published_pages');
    expect(sql()).toContain('project_id uuid not null');
    expect(sql()).toContain('force row level security');
    expect(sql()).toContain('create policy tenant_isolation on app.published_pages');
  });

  it('grants the reader select on this table only, explicitly', () => {
    expect(sql()).toMatch(/grant select on app\.published_pages to drefyn_public_reader/);
    expect(sql()).not.toMatch(/grant (insert|update|delete|truncate|all)/);
    expect(sql()).not.toContain('default privileges');
  });

  it('adds a reader select policy that needs both organization and project', () => {
    const policy =
      /create policy published_read on app\.published_pages(.*?)(;|$)/.exec(sql())?.[1] ?? '';
    expect(policy).toMatch(/for select/);
    expect(policy).toMatch(/to drefyn_public_reader/);
    expect(policy).toMatch(/organization_id = app\.current_org\(\)/);
    expect(policy).toMatch(/project_id = app\.current_project\(\)/);
    expect(policy).not.toMatch(/is null/);
  });
});

describe('tenantTableSql input', () => {
  it.each([
    ['an empty name', ''],
    ['a qualified name', 'public.notes'],
    ['a quoted name', '"Notes"'],
    ['an injection', 'notes (id int); drop table app.projects; --'],
    ['upper case', 'Notes'],
    ['a name over 63 bytes', 'n'.repeat(64)],
    ['a leading digit', '1notes'],
  ])('refuses %s', (_label, name) => {
    expect(() => tenantTableSql({ ...notes, name })).toThrow(/table name/);
  });

  it.each(['organization_id uuid', 'project_id uuid', 'id uuid'])(
    'refuses a column that redefines %s',
    (column) => {
      expect(() => tenantTableSql({ ...notes, columns: [column] })).toThrow(/column/);
    },
  );

  it('refuses an unsafe projects table name', () => {
    expect(() => tenantTableSql({ ...notes, projectsTable: 'projects; drop table x' })).toThrow(
      /projects table/,
    );
  });

  it('refuses a scope it does not know', () => {
    const error = thrown(() =>
      tenantTableSql({ ...notes, scope: 'global' as TenantTableSpec['scope'] }),
    );
    expect(String(error)).toMatch(/unknown scope/);
  });
});
