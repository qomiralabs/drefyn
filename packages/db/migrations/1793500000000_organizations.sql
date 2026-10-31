-- Organizations, their URL names, who belongs to them, and their projects. All four carry
-- organization_id with the standard policy. A user context reaches an organization and its
-- slug only through the person's own membership, read only, so a non member's slug resolves
-- to nothing. Foreign keys into organizations do not cascade: deleting an organization is
-- its own reviewed flow, never a side effect.

-- Up Migration
create table app.organizations (
  organization_id uuid primary key,
  name text not null check (char_length(name) between 1 and 100),
  -- The tiers of the plan table. Only billing changes it after creation.
  plan_tier text not null
    check (plan_tier in ('free', 'starter', 'growth', 'scale', 'enterprise', 'self_hosted')),
  read_only_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app.organizations enable row level security;
alter table app.organizations force row level security;

create policy tenant_isolation on app.organizations to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- URLs are /<slug>/..., so the slug is one namespace across every organization. That makes
-- its key the one unique constraint on a tenant table without organization_id.
create table app.organization_slugs (
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  organization_id uuid not null references app.organizations (organization_id),
  created_at timestamptz not null default now(),
  constraint organization_slugs_slug_key primary key (slug),
  constraint organization_slugs_organization_id_key unique (organization_id)
);

alter table app.organization_slugs enable row level security;
alter table app.organization_slugs force row level security;

create policy tenant_isolation on app.organization_slugs to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- A user's row going away must not silently take an organization's last owner with it.
create table app.memberships (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  user_id uuid not null references app.users (id),
  role text not null check (role in ('owner', 'admin', 'member')),
  default_project_role text check (default_project_role in ('editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_organization_user_key unique (organization_id, user_id),
  constraint memberships_organization_id_id_key unique (organization_id, id)
);

-- The user context finds a person's memberships by user alone.
create index memberships_user_id_idx on app.memberships (user_id);

alter table app.memberships enable row level security;
alter table app.memberships force row level security;

create policy tenant_isolation on app.memberships to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());
create policy self_read on app.memberships for select to drefyn_app
  using (user_id = app.current_user_id());

create policy member_read on app.organizations for select to drefyn_app
  using (exists (select from app.memberships m
                  where m.organization_id = organizations.organization_id
                    and m.user_id = app.current_user_id()));
create policy member_read on app.organization_slugs for select to drefyn_app
  using (exists (select from app.memberships m
                  where m.organization_id = organization_slugs.organization_id
                    and m.user_id = app.current_user_id()));

-- Project tables point here with (organization_id, project_id), so a row can never name a
-- project of another organization.
create table app.projects (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  product text not null check (product in ('docs', 'studio', 'status')),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 100),
  read_only_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_organization_id_id_key unique (organization_id, id),
  constraint projects_organization_product_slug_key unique (organization_id, product, slug)
);

alter table app.projects enable row level security;
alter table app.projects force row level security;

create policy tenant_isolation on app.projects to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- Down Migration
drop table app.projects;

drop policy member_read on app.organization_slugs;

drop policy member_read on app.organizations;

drop table app.memberships;

drop table app.organization_slugs;

drop table app.organizations;
