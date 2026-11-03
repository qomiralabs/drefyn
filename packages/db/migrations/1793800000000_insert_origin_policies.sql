-- Column grants stop drefyn_app from changing a role, a plan tier or a read only state, but
-- they cannot limit what an insert writes. These policies tie each of those values to a fact
-- the caller cannot choose. Restrictive, so they only ever narrow tenant_isolation.

-- Up Migration
-- The tier every new organization starts on. The hosted build replaces this from its own
-- migration, so the install decides the tier and no request or build flag can.
create function app.install_tier() returns text
  language sql stable parallel safe security invoker
  as $$ select 'self_hosted'::text $$;

revoke execute on function app.install_tier() from public;

grant execute on function app.install_tier() to drefyn_app;

create policy organization_insert_tier on app.organizations
  as restrictive for insert to drefyn_app
  with check (plan_tier = app.install_tier() and read_only_since is null);

-- The only member a plain insert may create is the first owner, in the transaction that made
-- the organization. now() is the transaction start and drefyn_app cannot update created_at, so
-- an organization left without members later cannot be claimed. Every other member needs a
-- source the database can see, added by its own reviewed change.
create policy membership_insert_origin on app.memberships
  as restrictive for insert to drefyn_app
  with check (
    role = 'owner'
    and not exists (select from app.memberships m
                     where m.organization_id = memberships.organization_id)
    and exists (select from app.organizations o
                 where o.organization_id = memberships.organization_id
                   and o.created_at = now()));

-- Down Migration
drop policy membership_insert_origin on app.memberships;

drop policy organization_insert_tier on app.organizations;

drop function app.install_tier();
