-- The GitHub App. An installation row says which App installation a project may mint tokens
-- from, and for which repositories; the broker refuses any other. Webhook deliveries are kept
-- by id and by body digest so a redelivery or a replayed signature is taken once. They arrive
-- before anyone knows which tenant they belong to, so that table holds no tenant data and only
-- the empty context reaches it.

-- Up Migration
create table app.github_installations (
  organization_id uuid not null,
  project_id uuid not null,
  installation_id bigint not null check (installation_id > 0),
  account_id bigint not null check (account_id > 0),
  -- The repositories this project may ask tokens for. A check cannot hold a subquery, so the
  -- store refuses repeats and writes the list sorted.
  repository_ids bigint[] not null check (
    array_ndims(repository_ids) = 1
    and cardinality(repository_ids) between 1 and 100
    and array_position(repository_ids, null) is null
    and 0 < all (repository_ids)
  ),
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint github_installations_pkey primary key (organization_id, project_id, installation_id),
  constraint github_installations_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

alter table app.github_installations enable row level security;
alter table app.github_installations force row level security;
create policy tenant_isolation on app.github_installations to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

create table app.github_webhook_deliveries (
  delivery_id uuid primary key,
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  event text not null check (event ~ '^[a-z_]{1,64}$'),
  received_at timestamptz not null default now(),
  constraint github_webhook_deliveries_body_key unique (body_sha256)
);

create index github_webhook_deliveries_received_idx
  on app.github_webhook_deliveries (received_at);

alter table app.github_webhook_deliveries enable row level security;
alter table app.github_webhook_deliveries force row level security;

-- Insert to claim, select for the claim's answer, delete to release and to age rows out.
-- Never update: a delivery is taken or it is not.
revoke all on app.github_webhook_deliveries from drefyn_app;
grant select, insert, delete on app.github_webhook_deliveries to drefyn_app;

-- Only in the empty context withWebhookLedger sets: tenant work runs as drefyn_app too, and
-- must neither read deliveries nor take one.
create policy webhook_access on app.github_webhook_deliveries to drefyn_app
  using (app.current_org() is null and app.current_project() is null and app.current_user_id() is null)
  with check (app.current_org() is null and app.current_project() is null and app.current_user_id() is null);

-- Down Migration
drop table app.github_webhook_deliveries;

drop table app.github_installations;
