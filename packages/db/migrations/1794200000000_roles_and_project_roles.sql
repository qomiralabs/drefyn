-- Role changes, removal and project roles. drefyn_app may now update a membership's role, but
-- only through restrictive policies keyed to the person acting: an owner sets any role, an
-- admin never touches an owner row and never writes owner, a member changes nothing, and no
-- change or removal leaves the organization without an owner. The code locks the
-- organization row before it decides, so the owner arms are the backstop, not the rule.

-- Up Migration
revoke update on app.memberships from drefyn_app;
grant update (role, default_project_role, updated_at) on app.memberships to drefyn_app;

-- The acting person's stored role, never the one the guard saw at the start of the request.
create policy membership_update_actor on app.memberships
  as restrictive for update to drefyn_app
  using (exists (select from app.memberships a
                  where a.organization_id = memberships.organization_id
                    and a.user_id = app.current_actor_id()
                    and (a.role = 'owner'
                         or (a.role = 'admin' and memberships.role <> 'owner'))))
  with check (
    exists (select from app.memberships a
             where a.organization_id = memberships.organization_id
               and a.user_id = app.current_actor_id()
               and (a.role = 'owner'
                    or (a.role = 'admin' and memberships.role <> 'owner')))
    and (memberships.role = 'owner'
         or exists (select from app.memberships o
                     where o.organization_id = memberships.organization_id
                       and o.role = 'owner'
                       and o.id <> memberships.id)));

create policy membership_delete_actor on app.memberships
  as restrictive for delete to drefyn_app
  using (
    exists (select from app.memberships a
             where a.organization_id = memberships.organization_id
               and a.user_id = app.current_actor_id()
               and (a.role = 'owner'
                    or (a.role = 'admin' and memberships.role <> 'owner')))
    and (memberships.role <> 'owner'
         or exists (select from app.memberships o
                     where o.organization_id = memberships.organization_id
                       and o.role = 'owner'
                       and o.id <> memberships.id)));

-- The other owner probe, which every owner change and removal runs.
create index memberships_owner_idx on app.memberships (organization_id) where role = 'owner';

-- A member's role on one project, overriding their default project role there. Owners and
-- admins are project admins everywhere and need no row.
create table app.project_roles (
  organization_id uuid not null,
  membership_id uuid not null,
  -- Not project_id: the table is read in organization work, not under one project's context.
  target_project_id uuid not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_roles_pkey primary key (organization_id, membership_id, target_project_id),
  constraint project_roles_membership_fkey foreign key (organization_id, membership_id)
    references app.memberships (organization_id, id) on delete cascade,
  constraint project_roles_project_fkey foreign key (organization_id, target_project_id)
    references app.projects (organization_id, id) on delete cascade
);

create index project_roles_target_idx on app.project_roles (organization_id, target_project_id);

alter table app.project_roles enable row level security;
alter table app.project_roles force row level security;

-- A row is granted, changed or taken away; it never moves to another person or project.
revoke update on app.project_roles from drefyn_app;
grant update (role, updated_at) on app.project_roles to drefyn_app;

create policy tenant_isolation on app.project_roles to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

create policy project_role_insert_actor on app.project_roles
  as restrictive for insert to drefyn_app
  with check (exists (select from app.memberships a
                       where a.organization_id = project_roles.organization_id
                         and a.user_id = app.current_actor_id()
                         and a.role in ('owner', 'admin')));

create policy project_role_update_actor on app.project_roles
  as restrictive for update to drefyn_app
  using (exists (select from app.memberships a
                  where a.organization_id = project_roles.organization_id
                    and a.user_id = app.current_actor_id()
                    and a.role in ('owner', 'admin')))
  with check (exists (select from app.memberships a
                       where a.organization_id = project_roles.organization_id
                         and a.user_id = app.current_actor_id()
                         and a.role in ('owner', 'admin')));

create policy project_role_delete_actor on app.project_roles
  as restrictive for delete to drefyn_app
  using (exists (select from app.memberships a
                  where a.organization_id = project_roles.organization_id
                    and a.user_id = app.current_actor_id()
                    and a.role in ('owner', 'admin')));

-- Down Migration
drop table app.project_roles;

drop index app.memberships_owner_idx;

drop policy membership_delete_actor on app.memberships;

drop policy membership_update_actor on app.memberships;

revoke update on app.memberships from drefyn_app;
grant update (default_project_role, updated_at) on app.memberships to drefyn_app;
