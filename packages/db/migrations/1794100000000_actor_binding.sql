-- Binds the person a guarded row names to the person acting. drefyn.user_id stays empty in
-- organization work, because setting it would switch on the permissive user policies and show
-- the person's other organizations; the actor is a second setting that only restrictive
-- policies read. Work that names no actor gets none of these inserts.

-- Up Migration
-- Security invoker so a policy reads the caller's own transaction setting. nullif because a
-- setting set with is_local leaves an empty string behind after commit on a reused connection.
create function app.current_actor_id() returns uuid
  language sql stable security invoker
  as $$ select nullif(current_setting('drefyn.actor_user_id', true), '')::uuid $$;

revoke execute on function app.current_actor_id() from public;

grant execute on function app.current_actor_id() to drefyn_app;

drop policy api_key_insert_creator on app.api_keys;

create policy api_key_insert_creator on app.api_keys
  as restrictive for insert to drefyn_app
  with check (
    exists (select from app.memberships m
             where m.organization_id = api_keys.organization_id
               and m.id = api_keys.created_by
               and m.user_id = app.current_actor_id()
               and m.role in ('owner', 'admin')));

drop policy invitation_insert_inviter on app.invitations;

create policy invitation_insert_inviter on app.invitations
  as restrictive for insert to drefyn_app
  with check (exists (select from app.memberships m
                       where m.organization_id = invitations.organization_id
                         and m.id = invitations.invited_by
                         and m.user_id = app.current_actor_id()
                         and (m.role = 'owner'
                              or (m.role = 'admin' and invitations.role <> 'owner'))));

-- A resend names the person resending as inviter, so this holds on update too.
drop policy invitation_update_inviter on app.invitations;

create policy invitation_update_inviter on app.invitations
  as restrictive for update to drefyn_app
  using (true)
  with check (exists (select from app.memberships m
                       where m.organization_id = invitations.organization_id
                         and m.id = invitations.invited_by
                         and m.user_id = app.current_actor_id()
                         and (m.role = 'owner'
                              or (m.role = 'admin' and invitations.role <> 'owner'))));

-- The creator becomes the first owner and the invitee becomes the member, so either way the
-- new row is the person acting.
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

-- Down Migration
drop policy membership_insert_origin on app.memberships;

create policy membership_insert_origin on app.memberships
  as restrictive for insert to drefyn_app
  with check (
    (role = 'owner'
      and not exists (select from app.memberships m
                       where m.organization_id = memberships.organization_id)
      and exists (select from app.organizations o
                   where o.organization_id = memberships.organization_id
                     and o.created_at = now()))
    or exists (select from app.invitations i
                where i.organization_id = memberships.organization_id
                  and i.id = memberships.invitation_id
                  and i.role = memberships.role
                  and i.expires_at > now()));

drop policy invitation_update_inviter on app.invitations;

create policy invitation_update_inviter on app.invitations
  as restrictive for update to drefyn_app
  using (true)
  with check (exists (select from app.memberships m
                       where m.organization_id = invitations.organization_id
                         and m.id = invitations.invited_by
                         and (m.role = 'owner'
                              or (m.role = 'admin' and invitations.role <> 'owner'))));

drop policy invitation_insert_inviter on app.invitations;

create policy invitation_insert_inviter on app.invitations
  as restrictive for insert to drefyn_app
  with check (exists (select from app.memberships m
                       where m.organization_id = invitations.organization_id
                         and m.id = invitations.invited_by
                         and (m.role = 'owner'
                              or (m.role = 'admin' and invitations.role <> 'owner'))));

drop policy api_key_insert_creator on app.api_keys;

create policy api_key_insert_creator on app.api_keys
  as restrictive for insert to drefyn_app
  with check (
    exists (select from app.memberships m
             where m.organization_id = api_keys.organization_id
               and m.id = api_keys.created_by
               and m.role in ('owner', 'admin')));

revoke execute on function app.current_actor_id() from drefyn_app;

drop function app.current_actor_id();
