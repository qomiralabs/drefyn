-- Adds drefyn_auth to a database bootstrapped before the role existed. bootstrap.sql never
-- runs twice and drefyn_owner cannot create roles, so this is the one step for those
-- databases. Run it as the bootstrap superuser, or the master user on managed Postgres, with
-- the role's password in the environment. It is safe to run again: a role that already exists
-- is checked, never changed, and the run stops if its attributes differ.
--
--   DREFYN_AUTH_PASSWORD=... psql --no-psqlrc --dbname drefyn --file 0001-auth-role.sql
--
-- On compose, bash scripts/selfhost.sh upgrade runs it with the password from deploy/.env.
-- It needs psql 10 or later for \if and \gset.

\set ON_ERROR_STOP on

-- Turns off everything that could log or keep the password, or stops. Before \getenv.
\ir ../quiet-log.sql
\if :{?drefyn_log_quiet}
\else
  \warn 'upgrade: quiet-log.sql did not finish, so the password could reach the server log; nothing was changed'
  select where false \gset
\endif

-- Schema app and drefyn_owner come from the bootstrap's one transaction.
select exists (select from pg_catalog.pg_namespace where nspname = 'app')
  and exists (select from pg_catalog.pg_roles where rolname = 'drefyn_owner') as bootstrapped \gset
\if :bootstrapped
\else
  \warn 'upgrade: this database was never bootstrapped; run deploy/postgres/bootstrap.sql first, which creates drefyn_auth itself. Nothing was changed'
  select where false \gset
\endif

select current_database() as dbname \gset

select not exists (
  select from pg_catalog.pg_roles where rolname = 'drefyn_auth'
) as need \gset

\if :need
  \getenv auth_password DREFYN_AUTH_PASSWORD
  \if :{?auth_password}
  \else
    \warn 'upgrade: set DREFYN_AUTH_PASSWORD to the password drefyn_auth should have; nothing was changed'
    select where false \gset
  \endif
  -- pg_stat_statements stores this with the literal replaced, and logging is off.
  select length(:'auth_password') >= 16 as long_enough \gset
  \if :long_enough
  \else
    \warn 'upgrade: DREFYN_AUTH_PASSWORD must be at least 16 characters; nothing was changed'
    select where false \gset
  \endif

  -- The same attributes as the bootstrap: no way around row level security, and NOINHERIT so
  -- a later membership grant cannot quietly hand it another role's rights.
  begin;
  create role drefyn_auth login nosuperuser nobypassrls nocreaterole nocreatedb noinherit
    password :'auth_password';
  grant connect on database :"dbname" to drefyn_auth;
  commit;
  \unset auth_password
  \echo 'upgrade: created drefyn_auth and granted it CONNECT on' :"dbname"
\else
  -- Someone made the role by hand or with other settings. Carrying on would hand the sign in
  -- path whatever it has, so stop and say what differs. The startup role check is the second
  -- line, but it only runs when the auth pool opens.
  -- One list of differences, and the verdict is only whether it is empty, so the two can
  -- never disagree. alter role ... set lives in pg_db_role_setting with database 0 and shows
  -- as rolconfig; only rows for one database count as per database settings.
  select differences, differences = '' as attributes_ok,
    'upgrade: drefyn_auth already exists with other attributes (' || differences
      || '); expected login nosuperuser nobypassrls nocreaterole nocreatedb noinherit'
      || ' noreplication and no settings or memberships. Nothing was changed. Fix it as the'
      || ' superuser with alter role, revoke and reset, then run this again' as refusal
  from (
    select concat_ws(', ',
        case when not rolcanlogin then 'nologin' end,
        case when rolsuper then 'superuser' end,
        case when rolbypassrls then 'bypassrls' end,
        case when rolcreaterole then 'createrole' end,
        case when rolcreatedb then 'createdb' end,
        case when rolinherit then 'inherit' end,
        case when rolreplication then 'replication' end,
        case when rolconfig is not null then 'role settings' end,
        case when exists (select from pg_catalog.pg_db_role_setting s
            where s.setrole = r.oid and s.setdatabase <> 0)
          then 'per database settings' end,
        case when exists (select from pg_catalog.pg_auth_members m where m.member = r.oid)
          then 'membership in another role' end) as differences
    from pg_catalog.pg_roles r where rolname = 'drefyn_auth'
  ) found \gset
  \if :attributes_ok
    grant connect on database :"dbname" to drefyn_auth;
    \echo 'upgrade: drefyn_auth already exists with the expected attributes; CONNECT on' :"dbname" 'is granted'
  \else
    \warn :refusal
    select where false \gset
  \endif
\endif
