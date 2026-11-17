-- What a node with no override anywhere above it gets, and the record of every visibility
-- change. A project with no site_access row is public, as every project was before. The log is
-- append only for the application role, so who widened a page stays provable, and it names the
-- actor by kind and opaque id only. Its key makes a retried change one change.

-- Up Migration
create table app.site_access (
  organization_id uuid not null,
  project_id uuid not null,
  default_visibility text not null
    constraint site_access_default_visibility_check
      check (default_visibility in ('public', 'protected')),
  updated_at timestamptz not null default now(),
  constraint site_access_pkey primary key (organization_id, project_id),
  constraint site_access_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.visibility_log (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  -- Null when the change was to the site default.
  node_id uuid,
  -- What was set. Null on a node means it follows its parent again.
  override text check (override in ('public', 'protected')),
  effective text not null check (effective in ('public', 'protected')),
  widened boolean not null,
  nodes_changed integer not null check (nodes_changed >= 0),
  actor_kind text not null check (actor_kind in ('user', 'api_key', 'git')),
  actor_id text not null check (char_length(actor_id) between 1 and 64),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  changed_at timestamptz not null default now(),
  -- A site default always names a value; only a node can go back to following.
  constraint visibility_log_site_override_check check (node_id is not null or override is not null),
  constraint visibility_log_idempotency_key unique (organization_id, project_id, idempotency_key),
  constraint visibility_log_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint visibility_log_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id)
);

create index visibility_log_node on app.visibility_log (organization_id, project_id, node_id);

revoke update, delete on app.visibility_log from drefyn_app;

alter table app.site_access enable row level security;
alter table app.site_access force row level security;
create policy tenant_isolation on app.site_access to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.visibility_log enable row level security;
alter table app.visibility_log force row level security;
create policy tenant_isolation on app.visibility_log to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
-- Dropping site_access turns every shut site default back to public at the next publish. A real
-- rollback needs a person to open those sites first; this only exists so the migration reverts.
drop table app.visibility_log;

drop table app.site_access;
