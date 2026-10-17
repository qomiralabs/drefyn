-- One time database bootstrap, run by a superuser against the drefyn database: the compose
-- init script does it on first start, and on a managed database the master user runs it
-- with psql. It is the only step that needs a superuser, so it also installs pgvector.
-- Grants on app and policies come from migrations, which run as drefyn_owner.
--
-- Passwords are read from the environment so they never live in a SQL file or in psql's
-- command line:
--   DREFYN_OWNER_PASSWORD, DREFYN_APP_PASSWORD, DREFYN_PUBLIC_READER_PASSWORD
--
--   psql --no-psqlrc --dbname drefyn --file bootstrap.sql

\set ON_ERROR_STOP on
\getenv owner_password DREFYN_OWNER_PASSWORD
\getenv app_password DREFYN_APP_PASSWORD
\getenv reader_password DREFYN_PUBLIC_READER_PASSWORD

select :{?owner_password} and :{?app_password} and :{?reader_password} as have_passwords \gset
\if :have_passwords
\else
  do $$ begin raise exception 'set DREFYN_OWNER_PASSWORD, DREFYN_APP_PASSWORD and DREFYN_PUBLIC_READER_PASSWORD'; end $$;
\endif

-- An empty password would leave a role that cannot log in, and a short one is a guess away.
select least(length(:'owner_password'), length(:'app_password'), length(:'reader_password')) >= 16
  as long_enough \gset
\if :long_enough
\else
  do $$ begin raise exception 'each role password must be at least 16 characters'; end $$;
\endif

begin;

-- None of these can skip row level security. The app and reader roles are NOINHERIT so a
-- later membership grant cannot quietly hand them another role's rights.
create role drefyn_owner login nosuperuser nobypassrls nocreaterole nocreatedb
  password :'owner_password';
create role drefyn_app login nosuperuser nobypassrls nocreaterole nocreatedb noinherit
  password :'app_password';
create role drefyn_public_reader login nosuperuser nobypassrls nocreaterole nocreatedb noinherit
  password :'reader_password';

create schema app authorization drefyn_owner;

-- pgvector is not a trusted extension, so only a superuser can create it, and this is the
-- only step that runs as one. Its own schema keeps it out of public and out of app, where
-- catalog checks look at every object.
create schema extensions authorization drefyn_owner;
create extension if not exists vector schema extensions;
grant usage on schema extensions to drefyn_app, drefyn_public_reader;

alter role drefyn_owner set search_path = app, extensions;
alter role drefyn_app set search_path = app, extensions;
alter role drefyn_public_reader set search_path = app, extensions;

-- Product tables live in app. Nothing should land in public by accident.
revoke all on schema public from public;

-- PUBLIC gets CONNECT and TEMP on a new database. A role made later should not be able to
-- connect without a grant, and temp tables are a place to stage data outside row level
-- security.
select current_database() as dbname \gset
revoke all on database :"dbname" from public;
grant connect on database :"dbname" to drefyn_owner, drefyn_app, drefyn_public_reader;

commit;

\unset owner_password
\unset app_password
\unset reader_password
