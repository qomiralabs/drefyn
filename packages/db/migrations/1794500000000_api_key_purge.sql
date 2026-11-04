-- Revoked keys leave 90 days after revoked_at, through the expiry cleanup, which runs as
-- drefyn_auth. The role finds its rows by this one column and can read or delete nothing else:
-- every row inside the limit, and every live key, stays hidden from it.

-- Up Migration
create index api_keys_revoked_at_idx on app.api_keys (revoked_at) where revoked_at is not null;

grant select (ctid, revoked_at) on app.api_keys to drefyn_auth;
grant delete on app.api_keys to drefyn_auth;

-- Whatever the auth role sends, it can only ever remove a key revoked over 90 days ago.
create policy auth_expire on app.api_keys for delete to drefyn_auth
  using (revoked_at < now() - interval '90 days');
-- A delete that filters on a column also passes through the select policies, so with no read
-- policy the cleanup would delete nothing and still report success.
create policy auth_expire_read on app.api_keys for select to drefyn_auth
  using (revoked_at < now() - interval '90 days');

-- Down Migration
drop policy auth_expire_read on app.api_keys;

drop policy auth_expire on app.api_keys;

revoke delete on app.api_keys from drefyn_auth;

revoke select (ctid, revoked_at) on app.api_keys from drefyn_auth;

drop index app.api_keys_revoked_at_idx;
