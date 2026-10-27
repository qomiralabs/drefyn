-- Postgres lets PUBLIC execute every new function, and every role is a member of PUBLIC, so
-- a reader allow list for functions would mean nothing. This takes that default away for
-- functions drefyn_owner creates, grants the two tenant context readers explicitly, and lets
-- the public reader see schema app. The reader still gets no table until a published table
-- grants it one.

-- Up Migration
alter default privileges for role drefyn_owner revoke execute on functions from public;

revoke execute on function app.current_org(), app.current_project() from public;

grant execute on function app.current_org(), app.current_project()
  to drefyn_app, drefyn_public_reader;

grant usage on schema app to drefyn_public_reader;

-- Down Migration
revoke usage on schema app from drefyn_public_reader;

revoke execute on function app.current_org(), app.current_project()
  from drefyn_app, drefyn_public_reader;

grant execute on function app.current_org(), app.current_project() to public;

alter default privileges for role drefyn_owner grant execute on functions to public;
