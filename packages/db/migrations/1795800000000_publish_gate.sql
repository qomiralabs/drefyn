-- What the publish gate reads and leaves behind. A project's workflow says whether a version
-- needs an approval before it goes out and whether keys or git pushes may publish at all; a
-- project with no row gets the strict answer to both. Approvals and publishes are logs: the
-- application role may add a row and never change or remove one, so who approved and who
-- published stays provable. A log names its actor by kind and opaque id only, never an address.

-- Up Migration
create table app.publish_workflows (
  organization_id uuid not null,
  project_id uuid not null,
  approval_required boolean not null default false,
  api_keys_publish boolean not null default false,
  git_publish boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint publish_workflows_pkey primary key (organization_id, project_id),
  constraint publish_workflows_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.publish_approvals (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  approver_id uuid not null,
  approved_at timestamptz not null default now(),
  -- The same person approving twice is one approval, so a double click adds nothing.
  constraint publish_approvals_version_approver_key
    unique (organization_id, project_id, version_id, approver_id),
  constraint publish_approvals_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint publish_approvals_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.node_versions (organization_id, project_id, node_id, id)
);

create table app.publish_log (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  expected_head_version_id uuid not null,
  -- The version that was current before, null on a first publish.
  previous_version_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'api_key', 'git')),
  actor_id text not null check (char_length(actor_id) between 1 and 64),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  render_policy_version integer not null check (render_policy_version >= 1),
  published_at timestamptz not null default now(),
  constraint publish_log_idempotency_key unique (organization_id, project_id, idempotency_key),
  constraint publish_log_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint publish_log_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.node_versions (organization_id, project_id, node_id, id)
);

create index publish_log_node on app.publish_log (organization_id, project_id, node_id);

revoke update, delete on app.publish_approvals, app.publish_log from drefyn_app;

alter table app.publish_workflows enable row level security;
alter table app.publish_workflows force row level security;
create policy tenant_isolation on app.publish_workflows to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.publish_approvals enable row level security;
alter table app.publish_approvals force row level security;
create policy tenant_isolation on app.publish_approvals to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

alter table app.publish_log enable row level security;
alter table app.publish_log force row level security;
create policy tenant_isolation on app.publish_log to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
drop table app.publish_log;

drop table app.publish_approvals;

drop table app.publish_workflows;
