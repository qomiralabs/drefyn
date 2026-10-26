-- Lets drefyn_app use schema app and read and write the tables drefyn_owner creates there
-- later, without ever owning or creating anything. Adds the two readers of the tenant
-- context that row level security policies call.

-- Up Migration
grant usage on schema app to drefyn_app;

alter default privileges for role drefyn_owner in schema app
  grant select, insert, update, delete on tables to drefyn_app;

alter default privileges for role drefyn_owner in schema app
  grant usage, select on sequences to drefyn_app;

-- Security invoker so a policy reads the caller's own transaction settings. nullif because a
-- setting set with is_local leaves an empty string behind after commit on a reused connection.
create function app.current_org() returns uuid
  language sql stable security invoker
  as $$ select nullif(current_setting('drefyn.organization_id', true), '')::uuid $$;

create function app.current_project() returns uuid
  language sql stable security invoker
  as $$ select nullif(current_setting('drefyn.project_id', true), '')::uuid $$;

-- Down Migration
drop function app.current_project();

drop function app.current_org();

alter default privileges for role drefyn_owner in schema app
  revoke usage, select on sequences from drefyn_app;

alter default privileges for role drefyn_owner in schema app
  revoke select, insert, update, delete on tables from drefyn_app;

revoke usage on schema app from drefyn_app;
