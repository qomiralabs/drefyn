-- Organization API keys and the projects a key is limited to. Both carry organization_id with
-- the standard policy, so a key read under one organization can never see another's. Only the
-- secret's SHA-256 is stored, with its last 4 characters for display.

-- Up Migration
create table app.api_keys (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  name text not null check (char_length(name) between 1 and 100),
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  display_suffix char(4) not null check (display_suffix ~ '^[0-9a-hjkmnp-tv-z]{4}$'),
  scopes text[] not null
    check (cardinality(scopes) between 1 and 32 and array_position(scopes, null) is null),
  -- Missing project rows must never read as every project, so the reach is its own column.
  project_scope text not null check (project_scope in ('all', 'listed')),
  created_by uuid,
  expires_at timestamptz,
  last_used_at timestamptz,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  created_at timestamptz not null default now(),
  -- Every scope has the registered shape. No shape has a space, so joining on one is exact.
  constraint api_keys_scope_shape check (
    (' ' || array_to_string(scopes, ' '))
      ~ '^( (docs|studio|status):[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30})?)+$'),
  constraint api_keys_expiry_after_creation check (expires_at is null or expires_at > created_at),
  constraint api_keys_organization_id_id_key unique (organization_id, id),
  constraint api_keys_organization_idempotency_key unique (organization_id, idempotency_key),
  -- Only the creator is cleared when their membership goes, never the organization.
  constraint api_keys_created_by_fkey foreign key (organization_id, created_by)
    references app.memberships (organization_id, id) on delete set null (created_by)
);

-- Removing a member finds the keys they made.
create index api_keys_created_by_idx on app.api_keys (organization_id, created_by);

alter table app.api_keys enable row level security;
alter table app.api_keys force row level security;

-- Organization work runs as drefyn_app, so RLS alone would let it swap a key's hash, widen its
-- scopes or move it to every project. Only the use time changes after creation.
revoke update on app.api_keys from drefyn_app;
grant update (last_used_at) on app.api_keys to drefyn_app;

create policy tenant_isolation on app.api_keys to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- A key always answers to someone who may manage keys: an owner or admin membership of the
-- same organization, so organization work cannot mint an ownerless key.
create policy api_key_insert_creator on app.api_keys
  as restrictive for insert to drefyn_app
  with check (
    exists (select from app.memberships m
             where m.organization_id = api_keys.organization_id
               and m.id = api_keys.created_by
               and m.role in ('owner', 'admin')));

create table app.api_key_projects (
  organization_id uuid not null,
  api_key_id uuid not null,
  target_project_id uuid not null,
  created_at timestamptz not null default now(),
  constraint api_key_projects_pkey primary key (organization_id, api_key_id, target_project_id),
  constraint api_key_projects_api_key_fkey foreign key (organization_id, api_key_id)
    references app.api_keys (organization_id, id) on delete cascade,
  -- A deleted project leaves the key with fewer projects, never more: project_scope stays.
  constraint api_key_projects_project_fkey foreign key (organization_id, target_project_id)
    references app.projects (organization_id, id) on delete cascade
);

create index api_key_projects_target_idx on app.api_key_projects (organization_id, target_project_id);

alter table app.api_key_projects enable row level security;
alter table app.api_key_projects force row level security;

-- Rows are added at creation and go with the key or the project; none is ever repointed.
revoke update on app.api_key_projects from drefyn_app;

create policy tenant_isolation on app.api_key_projects to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- Down Migration
drop table app.api_key_projects;

drop table app.api_keys;
