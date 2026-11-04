-- A revoked key stays as a row, so the idempotency key stays taken and a delayed create cannot
-- mint a live key after a revoke. Migrations run as a role forced row level security hides
-- these rows from, so force is lifted around the data changes or they would touch nothing.

-- Up Migration
alter table app.api_keys add column revoked_at timestamptz;

alter table app.api_keys no force row level security;

-- A key with no creator answers to nobody.
update app.api_keys set revoked_at = now() where created_by is null;

alter table app.api_keys force row level security;

-- Clearing created_by with a live key fails here, so a removal path that forgets to revoke is
-- loud instead of leaving a key behind.
alter table app.api_keys
  add constraint api_keys_ownerless_is_revoked
  check (created_by is not null or revoked_at is not null);

grant update (revoked_at) on app.api_keys to drefyn_app;

revoke delete on app.api_keys from drefyn_app;

-- A revoked key is final: its row can no longer be changed by organization work. with check
-- is spelled out because it would otherwise reuse using and refuse the revoke itself.
create policy api_key_update_unrevoked on app.api_keys
  as restrictive for update to drefyn_app
  using (revoked_at is null) with check (true);

-- Down Migration
drop policy api_key_update_unrevoked on app.api_keys;

grant delete on app.api_keys to drefyn_app;

revoke update (revoked_at) on app.api_keys from drefyn_app;

alter table app.api_keys drop constraint api_keys_ownerless_is_revoked;

alter table app.api_keys no force row level security;

-- Without the column these would read as live, so they go rather than come back to life.
delete from app.api_keys where revoked_at is not null;

alter table app.api_keys force row level security;

alter table app.api_keys drop column revoked_at;
