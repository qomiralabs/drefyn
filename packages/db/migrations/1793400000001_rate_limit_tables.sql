-- Fixed window counters. Keys are HMACs made by the caller, so neither table ever holds an
-- address or an IP. A window is stored with both ends: a bucket can have a 10 minute and a
-- daily window that start at the same instant, and the cleanup needs only the end.

-- Up Migration
-- Sign in limits, written only by drefyn_auth.
create table app.auth_rate_limits (
  bucket text not null check (bucket ~ '^[a-z][a-z0-9_]{0,62}$'),
  key_hmac bytea not null check (octet_length(key_hmac) = 32),
  window_start timestamptz not null,
  window_end timestamptz not null,
  count integer not null check (count > 0),
  constraint auth_rate_limits_window check (window_end > window_start),
  primary key (bucket, key_hmac, window_start, window_end)
);

create index auth_rate_limits_window_end_idx on app.auth_rate_limits (window_end);

alter table app.auth_rate_limits enable row level security;
alter table app.auth_rate_limits force row level security;

revoke all on app.auth_rate_limits from drefyn_app;
grant select, insert, update, delete on app.auth_rate_limits to drefyn_auth;

create policy auth_access on app.auth_rate_limits to drefyn_auth using (true) with check (true);

-- Failed API key checks, written by the API service as drefyn_app with its own HMAC key, so
-- the API service needs neither the auth role nor the auth secret. Delete is for the cleanup
-- of ended windows.
create table app.api_key_failures (
  key_hmac bytea not null check (octet_length(key_hmac) = 32),
  window_start timestamptz not null,
  window_end timestamptz not null,
  count integer not null check (count > 0),
  constraint api_key_failures_window check (window_end > window_start),
  primary key (key_hmac, window_start, window_end)
);

create index api_key_failures_window_end_idx on app.api_key_failures (window_end);

alter table app.api_key_failures enable row level security;
alter table app.api_key_failures force row level security;

revoke all on app.api_key_failures from drefyn_app;
grant select, insert, update, delete on app.api_key_failures to drefyn_app;

-- Only in the empty context withApiKeyLimiter sets: tenant and user work runs as drefyn_app
-- too, and must not reset or inflate the throttle.
create policy api_access on app.api_key_failures to drefyn_app
  using (app.current_org() is null and app.current_project() is null and app.current_user_id() is null)
  with check (app.current_org() is null and app.current_project() is null and app.current_user_id() is null);

-- Down Migration
drop table app.api_key_failures;

drop table app.auth_rate_limits;
