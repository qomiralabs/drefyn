-- Git sync binds one repository, branch and folder to a project. The file map remembers which
-- node each path became and the blob it was last synced from, so a push only fetches what
-- changed. Deliveries are a queue that coalesces to the newest per binding, because a worker
-- always converges on the branch head and older pushes add nothing. Outbound rows track the
-- commit each published change set becomes.

-- Up Migration
create table app.git_bindings (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null check (char_length(owner) between 1 and 100),
  name text not null check (char_length(name) between 1 and 100),
  branch text not null check (char_length(branch) between 1 and 255),
  -- '' is the repository root. Checked again here so no writer can bind a folder that walks
  -- out of the repository or starts at its root by accident.
  folder text not null check (
    char_length(folder) <= 1024
    and folder !~ '^/'
    and folder !~ '/$'
    and folder !~ '//'
    and folder !~ '(^|/)\.\.?(/|$)'
  ),
  last_synced_commit text check (last_synced_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  state text not null default 'active' check (state in ('active', 'paused', 'error')),
  -- Why a binding stopped, as a stable code the dashboard explains. Never message text.
  state_code text check (state_code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' and char_length(state_code) <= 63),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint git_bindings_tenant_id_key unique (organization_id, project_id, id),
  constraint git_bindings_project_key unique (organization_id, project_id),
  constraint git_bindings_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.git_files (
  organization_id uuid not null,
  project_id uuid not null,
  binding_id uuid not null,
  path text not null check (char_length(path) between 1 and 4096),
  node_id uuid not null,
  blob_sha text not null check (blob_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  synced_version_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint git_files_pkey primary key (organization_id, project_id, binding_id, path),
  -- A node is one file. Two paths on one node would make a publish write to both.
  constraint git_files_node_key unique (organization_id, project_id, node_id),
  constraint git_files_binding_fkey foreign key (organization_id, project_id, binding_id)
    references app.git_bindings (organization_id, project_id, id),
  -- Pairs the synced version with its node, so a row cannot name another node's version.
  constraint git_files_version_fkey
    foreign key (organization_id, project_id, node_id, synced_version_id)
    references app.node_versions (organization_id, project_id, node_id, id)
);

create table app.git_deliveries (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  binding_id uuid not null,
  delivery_id text not null check (delivery_id ~ '^[A-Za-z0-9:._-]{1,128}$'),
  -- Null for a reconcile, which reads the head when it runs.
  head_sha text check (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  received_at timestamptz not null default now(),
  state text not null default 'queued' check (state in ('queued', 'done', 'failed')),
  finished_at timestamptz,
  constraint git_deliveries_delivery_key unique (organization_id, project_id, delivery_id),
  constraint git_deliveries_binding_fkey foreign key (organization_id, project_id, binding_id)
    references app.git_bindings (organization_id, project_id, id)
);

-- The claim reads the newest queued row of one binding; finished rows never enter the index.
create index git_deliveries_queued
  on app.git_deliveries (organization_id, project_id, binding_id, received_at desc, id desc)
  where state = 'queued';

create table app.git_outbound (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  change_set_id uuid not null,
  binding_id uuid not null,
  state text not null default 'queued'
    check (state in ('queued', 'committed', 'conflict', 'failed')),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  attempts integer not null default 0 check (attempts between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint git_outbound_change_set_key unique (organization_id, project_id, change_set_id),
  constraint git_outbound_binding_fkey foreign key (organization_id, project_id, binding_id)
    references app.git_bindings (organization_id, project_id, id),
  -- A committed row always says which commit it became.
  constraint git_outbound_committed_sha check (state <> 'committed' or commit_sha is not null)
);

create statistics app.git_bindings_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.git_bindings;

alter table app.git_bindings enable row level security;
alter table app.git_bindings force row level security;
create policy tenant_isolation on app.git_bindings to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.git_files enable row level security;
alter table app.git_files force row level security;
create policy tenant_isolation on app.git_files to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.git_deliveries enable row level security;
alter table app.git_deliveries force row level security;
create policy tenant_isolation on app.git_deliveries to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.git_outbound enable row level security;
alter table app.git_outbound force row level security;
create policy tenant_isolation on app.git_outbound to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
drop table app.git_outbound;

drop table app.git_deliveries;

drop table app.git_files;

drop table app.git_bindings;
