-- Turning SSO enforcement on needs an active connection and an owner who just signed in
-- through it, and only the settings flow checks that. An insert could skip the flow by
-- writing enforcement on at birth, so the insert guard binds both columns to off. Both are
-- named so the policy refuses before the pairing check can answer with its own error.

-- Up Migration
drop policy organization_insert_tier on app.organizations;

create policy organization_insert_tier on app.organizations
  as restrictive for insert to drefyn_app
  with check (
    plan_tier = app.install_tier()
    and read_only_since is null
    and sso_enforcement = 'off'
    and sso_enforcement_since is null);

-- Down Migration
drop policy organization_insert_tier on app.organizations;

create policy organization_insert_tier on app.organizations
  as restrictive for insert to drefyn_app
  with check (plan_tier = app.install_tier() and read_only_since is null);
