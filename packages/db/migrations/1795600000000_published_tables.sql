-- What public paths read. The public reader holds no grant on any draft table, so published
-- content is a copy the publish transaction writes, never a view over drafts. One row per
-- published version; is_current marks the one a plain read gets, and older rows stay so a pin
-- can still name them. Filter rows mirror node_filter_rows for the current version only, so a
-- public list filters and sorts on the same covering key a draft list does.

-- Up Migration
create table app.published_versions (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  type_id uuid not null,
  content jsonb not null,
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  is_current boolean not null,
  render_policy_version integer not null check (render_policy_version >= 1),
  published_at timestamptz not null default now(),
  constraint published_versions_version_key
    unique (organization_id, project_id, node_id, version_id),
  constraint published_versions_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  -- Pairs the copy with the version and the node it came from, so it cannot name another
  -- tenant's or another node's version.
  constraint published_versions_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.node_versions (organization_id, project_id, node_id, id),
  constraint published_versions_node_fkey foreign key (organization_id, project_id, type_id, node_id)
    references app.nodes (organization_id, project_id, type_id, id)
);

-- A node has at most one current version, and a plain read finds it here.
create unique index published_versions_current
  on app.published_versions (organization_id, project_id, node_id)
  where is_current;

create table app.published_filter_rows (
  organization_id uuid not null,
  project_id uuid not null,
  type_id uuid not null,
  node_id uuid not null,
  t1 text,
  t2 text,
  t3 text,
  t4 text,
  t5 text,
  l1 text[],
  l2 text[],
  l3 text[],
  l4 text[],
  l5 text[],
  i1 bigint,
  i2 bigint,
  i3 bigint,
  i4 bigint,
  i5 bigint,
  d1 timestamptz,
  d2 timestamptz,
  constraint published_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, l1, l2, l3, l4, l5, i1, i2, i3, i4, i5, d1, d2),
  constraint published_filter_rows_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint published_filter_rows_node_fkey
    foreign key (organization_id, project_id, type_id, node_id)
    references app.nodes (organization_id, project_id, type_id, id)
)
-- Index only scans need a fresh visibility map, as on node_filter_rows.
with (fillfactor = 90, autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0,
      autovacuum_vacuum_insert_threshold = 2000, autovacuum_vacuum_insert_scale_factor = 0,
      autovacuum_vacuum_cost_delay = 0);

-- The planner otherwise treats the two tenant columns as independent and expects about one row
-- per tenant.
create statistics app.published_versions_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.published_versions;
create statistics app.published_filter_rows_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.published_filter_rows;

alter table app.published_versions enable row level security;
alter table app.published_versions force row level security;
create policy tenant_isolation on app.published_versions to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_versions for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

alter table app.published_filter_rows enable row level security;
alter table app.published_filter_rows force row level security;
create policy tenant_isolation on app.published_filter_rows to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_filter_rows for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

-- Granted per table and never by default privileges, so a new table stays invisible to the
-- reader until a migration names it.
grant select on app.published_versions, app.published_filter_rows to drefyn_public_reader;

-- Down Migration
revoke select on app.published_versions, app.published_filter_rows from drefyn_public_reader;

drop table app.published_filter_rows;

drop table app.published_versions;
