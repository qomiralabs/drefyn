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

-- These print every parse tree and plan, password literals included, to the server log. Any
-- session may turn them off, so no check is needed.
set debug_print_parse = off;
set debug_print_rewritten = off;
set debug_print_plan = off;

-- Keep passwords out of the server log. Statement logging, duration logging and sampling
-- would record the statements below that carry one, and an error would record the statement
-- that failed. This has to come before any of them.
select has_parameter_privilege('log_statement', 'SET')
  and has_parameter_privilege('log_min_error_statement', 'SET')
  and has_parameter_privilege('log_min_duration_statement', 'SET')
  and has_parameter_privilege('log_min_duration_sample', 'SET')
  and has_parameter_privilege('log_transaction_sample_rate', 'SET') as can_quiet_log \gset
\if :can_quiet_log
  set log_statement = 'none';
  set log_min_error_statement = 'panic';
  set log_min_duration_statement = -1;
  set log_min_duration_sample = -1;
  set log_transaction_sample_rate = 0;
\endif

-- pg_stat_statements keeps the text of utility statements, create role ... password included,
-- as soon as each one completes, even if the transaction later rolls back, and monitoring
-- roles can read it. Its setting only exists when the module is loaded.
select current_setting('pg_stat_statements.track_utility', true) is not null as pgss_loaded \gset
\if :pgss_loaded
  select has_parameter_privilege('pg_stat_statements.track_utility', 'SET') as pgss_can_set \gset
  \if :pgss_can_set
    set pg_stat_statements.track_utility = off;
  \endif
\endif

-- A managed database's master user may not be allowed to change these, and pgaudit and
-- auto_explain log whatever the session says. Stop unless this session really logs and keeps
-- no statements, failed ones included, or the operator has checked and says so. A library is
-- matched anywhere in the preload lists, so $libdir/pgaudit, pgaudit.so and quoted names
-- count, and a list this role cannot read counts as unsafe.
select current_setting('log_statement') = 'none'
  and current_setting('log_min_error_statement') in ('log', 'fatal', 'panic')
  and current_setting('log_min_duration_statement') = '-1'
  and current_setting('log_min_duration_sample') = '-1'
  and current_setting('log_transaction_sample_rate') = '0'
  and coalesce(current_setting('pg_stat_statements.track_utility', true), 'off') = 'off'
  and coalesce((
    select count(*) = 3 and bool_and(setting !~* '(pgaudit|auto_explain)')
    from pg_settings
    where name in ('shared_preload_libraries', 'session_preload_libraries',
      'local_preload_libraries')), false) as log_is_quiet \gset
\if :log_is_quiet
\else
  \getenv log_checked DREFYN_BOOTSTRAP_LOG_CHECKED
  \if :{?log_checked}
    select :'log_checked' = 'yes' as log_checked_yes \gset
  \else
    \set log_checked_yes false
  \endif
  \if :log_checked_yes
    \echo 'bootstrap: DREFYN_BOOTSTRAP_LOG_CHECKED=yes, so running with the server log settings as they are'
  \else
    do $$ begin raise exception 'bootstrap: statement logging, failed statement logging, duration logging or sampling, pgaudit, auto_explain or pg_stat_statements may record the passwords this file sets, and this role cannot turn them off. Check them, then set DREFYN_BOOTSTRAP_LOG_CHECKED=yes to run anyway'; end $$;
  \endif
\endif

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

-- The file runs once. Checking first means a second run stops with a plain message and never
-- reaches a statement that carries a password.
select exists (
    select from pg_roles where rolname in ('drefyn_owner', 'drefyn_app', 'drefyn_public_reader')
  ) or exists (select from pg_namespace where nspname in ('app', 'extensions'))
  as already_run \gset
\if :already_run
  do $$ begin raise exception 'the bootstrap has already run: drefyn roles or schemas exist, nothing was changed'; end $$;
\endif

select current_database() as dbname \gset

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
-- catalog checks look at every object. The superuser keeps both: an owner of the schema
-- could drop it with cascade, taking every vector column along, or add objects there that
-- the checks on app never see.
-- No if not exists: a vector already installed elsewhere, say in public, must stop the
-- bootstrap rather than be left where it is.
create schema extensions;
revoke all on schema extensions from public;
grant usage on schema extensions to drefyn_owner, drefyn_app, drefyn_public_reader;
create extension vector schema extensions;

-- Set on the database rather than on each role, so any role setting at all is drift that a
-- check can flag.
alter database :"dbname" set search_path = app, extensions;

-- Product tables live in app. Nothing should land in public by accident.
revoke all on schema public from public;

-- PUBLIC gets CONNECT and TEMP on a new database. A role made later should not be able to
-- connect without a grant, and temp tables are a place to stage data outside row level
-- security.
revoke all on database :"dbname" from public;
grant connect on database :"dbname" to drefyn_owner, drefyn_app, drefyn_public_reader;

-- Every cluster also has postgres and template1, open to PUBLIC the same way. New databases
-- do not copy these rights from template1. On a managed database the master user may not own
-- them, so skip those with a notice rather than fail the whole bootstrap.
do $$
declare
  db name;
begin
  for db in
    select datname from pg_database
    where datname in ('postgres', 'template1') and datname <> current_database()
  loop
    if (select rolsuper from pg_roles where rolname = current_user)
      or pg_has_role((select datdba from pg_database where datname = db), 'MEMBER') then
      execute format('revoke all on database %I from public', db);
    else
      raise notice 'bootstrap: left PUBLIC rights on database % as they were; only its owner can change them', db;
    end if;
  end loop;
end $$;

commit;

\unset owner_password
\unset app_password
\unset reader_password
