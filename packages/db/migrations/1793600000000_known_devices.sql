-- Browsers a person has signed in from, by a hash of a long lived device cookie. A known
-- device only picks a rate limit bucket and decides whether a sign in is new; it never signs
-- anyone in. Rows are written under the person's own user context after a sign in.

-- Up Migration
create table app.known_devices (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app.users (id) on delete cascade,
  device_hash bytea not null check (octet_length(device_hash) = 32),
  -- A coarse browser and system name, never the full user agent.
  user_agent_family text not null check (char_length(user_agent_family) between 1 and 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Leads with user_id, so it also serves the cascade, the exemption lookup and eviction.
  constraint known_devices_user_device_key unique (user_id, device_hash)
);

create index known_devices_last_seen_at_idx on app.known_devices (last_seen_at);

alter table app.known_devices enable row level security;
alter table app.known_devices force row level security;

-- Per column, so a column added later stays closed to both roles until someone grants it.
revoke all on app.known_devices from drefyn_app;
grant select (id, user_id, device_hash, user_agent_family, created_at, last_seen_at)
  on app.known_devices to drefyn_app;
grant insert (user_id, device_hash, user_agent_family) on app.known_devices to drefyn_app;
grant update (user_agent_family, last_seen_at) on app.known_devices to drefyn_app;
grant delete on app.known_devices to drefyn_app;

-- Sign in checks a device before anyone is signed in, and the expiry cleanup deletes by ctid.
-- Nothing else: no family, no insert, no update.
grant select (ctid, user_id, device_hash, last_seen_at) on app.known_devices to drefyn_auth;
grant delete on app.known_devices to drefyn_auth;

create policy self_access on app.known_devices to drefyn_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy auth_read on app.known_devices for select to drefyn_auth using (true);
-- Whatever the auth role sends, it can only ever remove a device unseen for 400 days.
create policy auth_expire on app.known_devices for delete to drefyn_auth
  using (last_seen_at < now() - interval '400 days');

-- Down Migration
drop table app.known_devices;
