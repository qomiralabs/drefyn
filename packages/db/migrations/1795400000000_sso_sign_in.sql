-- What SSO sign in writes beyond its own tables. A link code carries the connection and
-- subject it will link, a factor challenge can finish an SSO session, the sign in role marks
-- when a link was last used, and a membership can be born from a just in time connection.

-- Up Migration
-- The pending link names its connection as a pair, set exactly when the link is an SSO one.
-- No foreign key: email_challenges is global, and a key from it into a tenant table is
-- refused by the catalog rules.
alter table app.email_challenges
  add column pending_sso_organization_id uuid,
  add column pending_sso_connection_id uuid,
  add constraint email_challenges_pending_sso_check check (
    (coalesce(pending_provider = 'sso', false))
      = (pending_sso_organization_id is not null and pending_sso_connection_id is not null)
    and (pending_sso_organization_id is null) = (pending_sso_connection_id is null));

-- The identity migration left this check to Postgres to name. No if exists: a different name
-- must stop the migration rather than leave the old check beside the new one.
alter table app.email_challenges drop constraint email_challenges_pending_provider_check;
alter table app.email_challenges add constraint email_challenges_pending_provider_check
  check (pending_provider in ('github', 'google', 'sso'));

-- A sign in waiting on the factor keeps what its session will need, so an SSO session can
-- still carry both SSO columns once the factor passes.
alter table app.factor_challenges
  add column sso_connection_id uuid,
  add column sso_organization_id uuid,
  add constraint factor_challenges_sso_check check (
    (method = 'sso' and sso_connection_id is not null and sso_organization_id is not null)
    or (method <> 'sso' and sso_connection_id is null and sso_organization_id is null));

alter table app.factor_challenges drop constraint factor_challenges_method_check;
alter table app.factor_challenges add constraint factor_challenges_method_check check (method in
  ('email', 'password', 'github', 'google', 'cli_link', 'sso'));

grant select (sso_connection_id, sso_organization_id) on app.factor_challenges to drefyn_app;
grant insert (sso_connection_id, sso_organization_id) on app.factor_challenges to drefyn_app;

-- Only the timestamp moves: a link never changes person, subject or connection.
grant update (last_used_at) on app.sso_identities to drefyn_auth;

-- A just in time member is born only as member, from an identity the sign in role linked in
-- this organization, through an active connection that has just in time on, with that
-- connection's project role. Organization work cannot write an identity, so it cannot use
-- this arm to add anyone.
drop policy membership_insert_origin on app.memberships;

create policy membership_insert_origin on app.memberships
  as restrictive for insert to drefyn_app
  with check (
    user_id = app.current_actor_id()
    and ((role = 'owner'
          and not exists (select from app.memberships m
                           where m.organization_id = memberships.organization_id)
          and exists (select from app.organizations o
                       where o.organization_id = memberships.organization_id
                         and o.created_at = now()))
         or exists (select from app.invitations i
                     where i.organization_id = memberships.organization_id
                       and i.id = memberships.invitation_id
                       and i.role = memberships.role
                       and i.expires_at > now())
         or (role = 'member'
             and invitation_id is null
             and exists (select from app.sso_identities si
                          join app.sso_connections c
                            on c.organization_id = si.organization_id
                           and c.id = si.connection_id
                         where si.organization_id = memberships.organization_id
                           and si.user_id = memberships.user_id
                           and c.status = 'active'
                           and c.jit_enabled
                           and c.jit_default_project_role
                                 is not distinct from memberships.default_project_role))));

-- Down Migration
-- Pending SSO links and factor challenges go, since the older checks refuse them; both are
-- minutes old at most, and the person signs in again. Members who joined just in time stay.
-- The migration role matches no policy, so force is lifted around the deletes.
drop policy membership_insert_origin on app.memberships;

create policy membership_insert_origin on app.memberships
  as restrictive for insert to drefyn_app
  with check (
    user_id = app.current_actor_id()
    and ((role = 'owner'
          and not exists (select from app.memberships m
                           where m.organization_id = memberships.organization_id)
          and exists (select from app.organizations o
                       where o.organization_id = memberships.organization_id
                         and o.created_at = now()))
         or exists (select from app.invitations i
                     where i.organization_id = memberships.organization_id
                       and i.id = memberships.invitation_id
                       and i.role = memberships.role
                       and i.expires_at > now())));

revoke update (last_used_at) on app.sso_identities from drefyn_auth;

alter table app.factor_challenges no force row level security;
delete from app.factor_challenges where method = 'sso';
alter table app.factor_challenges force row level security;
alter table app.factor_challenges drop constraint factor_challenges_method_check;
alter table app.factor_challenges add constraint factor_challenges_method_check check (method in
  ('email', 'password', 'github', 'google', 'cli_link'));
alter table app.factor_challenges
  drop constraint factor_challenges_sso_check,
  drop column sso_organization_id,
  drop column sso_connection_id;

alter table app.email_challenges no force row level security;
delete from app.email_challenges where pending_provider = 'sso';
alter table app.email_challenges force row level security;
alter table app.email_challenges drop constraint email_challenges_pending_provider_check;
alter table app.email_challenges add constraint email_challenges_pending_provider_check
  check (pending_provider in ('github', 'google'));
alter table app.email_challenges
  drop constraint email_challenges_pending_sso_check,
  drop column pending_sso_connection_id,
  drop column pending_sso_organization_id;
