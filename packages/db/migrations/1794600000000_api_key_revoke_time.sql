-- The purge trusts revoked_at, so organization work may no longer pick its value: a backdated
-- revoke would delete a live key on the next run. The only writers set now(), which is also
-- the value the row is checked against, so the revoke and last_used_at still pass.
-- The auth role also learns which organization a key past the limit belonged to, so a purge
-- can be logged per organization. auth_expire_read still hides every other row.

-- Up Migration
alter policy api_key_update_unrevoked on app.api_keys
  with check (revoked_at is null or revoked_at = now());

grant select (organization_id) on app.api_keys to drefyn_auth;

-- Down Migration
revoke select (organization_id) on app.api_keys from drefyn_auth;

alter policy api_key_update_unrevoked on app.api_keys with check (true);
