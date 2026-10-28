-- Adds the reader of the user setting that user keyed policies call, for drefyn_app only, and
-- lets drefyn_auth see schema app. The auth role still gets no table until an identity table
-- grants it one.

-- Up Migration
-- Security invoker so a policy reads the caller's own transaction setting. nullif because a
-- setting set with is_local leaves an empty string behind after commit on a reused connection.
create function app.current_user_id() returns uuid
  language sql stable security invoker
  as $$ select nullif(current_setting('drefyn.user_id', true), '')::uuid $$;

revoke execute on function app.current_user_id() from public;

grant execute on function app.current_user_id() to drefyn_app;

grant usage on schema app to drefyn_auth;

-- Down Migration
revoke usage on schema app from drefyn_auth;

revoke execute on function app.current_user_id() from drefyn_app;

drop function app.current_user_id();
