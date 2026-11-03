-- Invitations, the addresses that asked not to get them, and the second way a membership is
-- born. A pending invitation holds a seat until it expires, so it lives beside memberships
-- under the same organization.

-- Up Migration
create table app.invitations (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  email_normalized text not null check (char_length(email_normalized) between 3 and 254),
  role text not null check (role in ('owner', 'admin', 'member')),
  default_project_role text check (default_project_role in ('editor', 'viewer')),
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  invited_by uuid not null,
  -- Counts sends of this row, so a resend gets its own mail idempotency key.
  send_count integer not null default 1 check (send_count >= 1),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invitations_organization_email_key unique (organization_id, email_normalized),
  constraint invitations_organization_id_id_key unique (organization_id, id),
  -- Removing the inviter takes their pending invitations with them, so nobody joins on the
  -- word of someone who no longer belongs.
  constraint invitations_invited_by_fkey foreign key (organization_id, invited_by)
    references app.memberships (organization_id, id) on delete cascade
);

create index invitations_organization_expires_idx on app.invitations (organization_id, expires_at);

-- Serves the cascade when a membership goes.
create index invitations_invited_by_idx on app.invitations (organization_id, invited_by);

alter table app.invitations enable row level security;
alter table app.invitations force row level security;

-- A resend replaces the secret, role, inviter and expiry in place. The address and the
-- organization never change.
revoke update on app.invitations from drefyn_app;
grant update (role, default_project_role, secret_hash, invited_by, send_count, expires_at,
  updated_at) on app.invitations to drefyn_app;

create policy tenant_isolation on app.invitations to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- Keyed by an HMAC of the address, so the table never holds who asked.
create table app.invitation_blocks (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references app.organizations (organization_id),
  email_hmac bytea not null check (octet_length(email_hmac) = 32),
  created_at timestamptz not null default now(),
  constraint invitation_blocks_organization_email_hmac_key unique (organization_id, email_hmac)
);

alter table app.invitation_blocks enable row level security;
alter table app.invitation_blocks force row level security;

-- The person asked; an admin of the organization must not be able to lift it.
revoke update, delete on app.invitation_blocks from drefyn_app;

create policy tenant_isolation on app.invitation_blocks to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

alter table app.memberships add column invitation_id uuid;

-- One invitation makes at most one membership, even if a flow forgets to delete it.
alter table app.memberships
  add constraint memberships_organization_invitation_key unique (organization_id, invitation_id);

alter table app.memberships
  add constraint memberships_invitation_fkey foreign key (organization_id, invitation_id)
    references app.invitations (organization_id, id) on delete set null (invitation_id);

-- The first owner arm is unchanged. The second lets a membership in only on a live
-- invitation of this organization that carries the same role.
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

-- Down Migration
drop policy membership_insert_origin on app.memberships;

create policy membership_insert_origin on app.memberships
  as restrictive for insert to drefyn_app
  with check (
    role = 'owner'
    and not exists (select from app.memberships m
                     where m.organization_id = memberships.organization_id)
    and exists (select from app.organizations o
                 where o.organization_id = memberships.organization_id
                   and o.created_at = now()));

alter table app.memberships drop constraint memberships_invitation_fkey;

alter table app.memberships drop constraint memberships_organization_invitation_key;

alter table app.memberships drop column invitation_id;

drop table app.invitation_blocks;

drop table app.invitations;
