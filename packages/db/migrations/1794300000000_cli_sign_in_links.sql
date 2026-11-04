-- Single use sign in links an operator prints with drefyn auth link. A row holds only the
-- person and a SHA-256 of a 32 byte secret, so the table never holds anything a reader
-- could sign in with. drefyn_app holds nothing here: links are redeemed before sign in.

-- Up Migration
create table app.cli_sign_in_links (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app.users (id) on delete cascade,
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cli_sign_in_links_secret_hash_key unique (secret_hash)
);

create index cli_sign_in_links_user_id_idx on app.cli_sign_in_links (user_id);
create index cli_sign_in_links_expires_at_idx on app.cli_sign_in_links (expires_at);

alter table app.cli_sign_in_links enable row level security;
alter table app.cli_sign_in_links force row level security;

revoke all on app.cli_sign_in_links from drefyn_app;
-- Redemption may only mark a row used; the hash, the person and the expiry never change.
grant select, insert, delete on app.cli_sign_in_links to drefyn_auth;
grant update (consumed_at) on app.cli_sign_in_links to drefyn_auth;

create policy auth_access on app.cli_sign_in_links to drefyn_auth using (true) with check (true);

-- Down Migration
drop table app.cli_sign_in_links;
