-- The content engine's tables. Customers add content types at run time, so one node table with
-- jsonb content holds every family and no type needs DDL. Every table is project scoped with
-- the standard policy and every reference carries organization and project, so a row can name
-- a parent only in its own tenant. Filter rows and head_content are derived and can be rebuilt
-- from node_versions.

-- Up Migration
create table app.content_types (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  family text not null check (family in ('docs_page', 'studio_item', 'status_component', 'status_incident', 'status_incident_update', 'status_maintenance', 'status_postmortem')),
  key text not null check (char_length(key) between 1 and 100),
  current_schema_version integer not null default 1 check (current_schema_version >= 1),
  -- Field id to slot per schema version. A field keeps its slot for life, so this is data the
  -- type owns and never derives.
  filter_slots jsonb not null default '{}' check (jsonb_typeof(filter_slots) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_types_tenant_id_key unique (organization_id, project_id, id),
  constraint content_types_key_key unique (organization_id, project_id, key),
  constraint content_types_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.nodes (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  family text not null check (family in ('docs_page', 'studio_item', 'status_component', 'status_incident', 'status_incident_update', 'status_maintenance', 'status_postmortem')),
  type_id uuid not null,
  parent_id uuid,
  -- A fractional string, so a move rewrites one row.
  order_key text not null,
  slug text,
  head_version_id uuid,
  published_version_id uuid,
  -- A copy of the head version: reading it here is 4 to 15 times faster than joining versions.
  head_content jsonb,
  lifecycle text not null check (lifecycle in ('draft', 'published', 'archived')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nodes_tenant_id_key unique (organization_id, project_id, id),
  constraint nodes_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint nodes_type_fkey foreign key (organization_id, project_id, type_id)
    references app.content_types (organization_id, project_id, id),
  constraint nodes_parent_fkey foreign key (organization_id, project_id, parent_id)
    references app.nodes (organization_id, project_id, id)
);

-- Filters on undeclared fields scan one type through this.
create index nodes_type on app.nodes (organization_id, project_id, type_id, id);
-- parent_id is null does not fix a sort order, so roots need their own index.
create index nodes_roots on app.nodes (organization_id, project_id, order_key)
  where parent_id is null;
create index nodes_children on app.nodes (organization_id, project_id, parent_id, order_key);

create table app.node_versions (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  seq bigint not null check (seq >= 1),
  parent_version_id uuid,
  schema_version integer not null check (schema_version >= 1),
  ast_version integer not null check (ast_version >= 1),
  origin text not null check (origin in ('human', 'ai', 'git', 'import')),
  actor jsonb not null,
  content jsonb not null,
  content_sha256 bytea not null check (octet_length(content_sha256) = 32),
  idempotency_key text check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint node_versions_tenant_id_key unique (organization_id, project_id, id),
  constraint node_versions_node_seq_key unique (organization_id, project_id, node_id, seq),
  constraint node_versions_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint node_versions_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id),
  constraint node_versions_parent_version_fkey
    foreign key (organization_id, project_id, parent_version_id)
    references app.node_versions (organization_id, project_id, id)
);

create unique index node_versions_idempotency_key
  on app.node_versions (organization_id, project_id, idempotency_key)
  where idempotency_key is not null;

-- Added here because nodes and versions point at each other. Both stay null until the first
-- save, so neither needs to be deferred.
alter table app.nodes
  add constraint nodes_head_version_fkey
    foreign key (organization_id, project_id, head_version_id)
    references app.node_versions (organization_id, project_id, id),
  add constraint nodes_published_version_fkey
    foreign key (organization_id, project_id, published_version_id)
    references app.node_versions (organization_id, project_id, id);

-- Without these the planner multiplies two columns that are really one, expects about one row
-- for a whole tenant, and a foreign key check walks the tenant's index. One check took 664 ms
-- and a 233 row chunk insert 42.9 s.
create statistics app.content_types_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.content_types;
create statistics app.nodes_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.nodes;
create statistics app.node_versions_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.node_versions;

-- One narrow row per node with typed slots for declared fields. Filters run on these small
-- tuples inside the covering key, after the policy, so no filter reads the heap or content and
-- every filter shape costs the same index scan. No other index: a second one would make a save
-- rewrite two keys.
create table app.node_filter_rows (
  organization_id uuid not null,
  project_id uuid not null,
  type_id uuid not null,
  node_id uuid not null,
  t1 text,
  t2 text,
  t3 text,
  t4 text,
  t5 text,
  i1 bigint,
  i2 bigint,
  i3 bigint,
  i4 bigint,
  i5 bigint,
  d1 timestamptz,
  d2 timestamptz,
  constraint node_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, i1, i2, i3, i4, i5, d1, d2),
  constraint node_filter_rows_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint node_filter_rows_type_fkey foreign key (organization_id, project_id, type_id)
    references app.content_types (organization_id, project_id, id),
  constraint node_filter_rows_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id)
)
-- Index only scans need a fresh visibility map. A scale factor counts the whole shared table,
-- so fixed thresholds keep the interval steady as the platform grows.
with (fillfactor = 90, autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0,
      autovacuum_vacuum_insert_threshold = 2000, autovacuum_vacuum_insert_scale_factor = 0,
      autovacuum_vacuum_cost_delay = 0);

create table app.chunks (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  ord integer not null check (ord >= 0),
  block_path text not null,
  heading_path text[] not null,
  body text not null,
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  created_at timestamptz not null default now(),
  constraint chunks_version_ord_key unique (organization_id, project_id, version_id, ord),
  constraint chunks_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint chunks_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id),
  constraint chunks_version_fkey foreign key (organization_id, project_id, version_id)
    references app.node_versions (organization_id, project_id, id)
);

create index chunks_node on app.chunks (organization_id, project_id, node_id);

-- Keyed by hash, not chunk, so an edit re-embeds only changed text. Per project, so a hash
-- cannot tell one tenant what another has written. The type has no dimension because models
-- differ; each model's index casts to its own.
create table app.chunk_embeddings (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  model_id text not null check (char_length(model_id) between 1 and 200),
  embedding halfvec not null,
  created_at timestamptz not null default now(),
  constraint chunk_embeddings_body_model_key
    unique (organization_id, project_id, body_sha256, model_id),
  constraint chunk_embeddings_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.engine_outbox (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  kind text not null check (char_length(kind) between 1 and 63),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  constraint engine_outbox_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint engine_outbox_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id),
  constraint engine_outbox_version_fkey foreign key (organization_id, project_id, version_id)
    references app.node_versions (organization_id, project_id, id)
);

create index engine_outbox_node on app.engine_outbox (organization_id, project_id, node_id);

alter table app.content_types enable row level security;
alter table app.content_types force row level security;
create policy tenant_isolation on app.content_types to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.nodes enable row level security;
alter table app.nodes force row level security;
create policy tenant_isolation on app.nodes to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.node_versions enable row level security;
alter table app.node_versions force row level security;
create policy tenant_isolation on app.node_versions to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.node_filter_rows enable row level security;
alter table app.node_filter_rows force row level security;
create policy tenant_isolation on app.node_filter_rows to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.chunks enable row level security;
alter table app.chunks force row level security;
create policy tenant_isolation on app.chunks to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.chunk_embeddings enable row level security;
alter table app.chunk_embeddings force row level security;
create policy tenant_isolation on app.chunk_embeddings to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.engine_outbox enable row level security;
alter table app.engine_outbox force row level security;
create policy tenant_isolation on app.engine_outbox to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
drop table app.engine_outbox;

drop table app.chunk_embeddings;

drop table app.chunks;

drop table app.node_filter_rows;

alter table app.nodes
  drop constraint nodes_head_version_fkey,
  drop constraint nodes_published_version_fkey;

drop table app.node_versions;

drop table app.nodes;

drop table app.content_types;
