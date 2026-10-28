-- Keeps role passwords out of the server log and pg_stat_statements for this psql session.
-- bootstrap.sql and every file in upgrade/ include it with \ir before they read a password.
-- It has no DO block on purpose: psql cannot put a variable inside one, so a script that
-- copied that pattern for create role would have to inline the password.
--
-- psql has no command that exits with an error, so each refusal prints its reason with \warn
-- and then fails a \gset that returns no rows, which ON_ERROR_STOP turns into exit 3.

\set ON_ERROR_STOP on

-- These print every parse tree and plan, password literals included, to the server log. Any
-- session may turn them off, so no check is needed.
set debug_print_parse = off;
set debug_print_rewritten = off;
set debug_print_plan = off;

-- Statement logging, duration logging and sampling would record the statements that carry a
-- password, and an error would record the statement that failed.
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
    \echo 'drefyn: DREFYN_BOOTSTRAP_LOG_CHECKED=yes, so running with the server log settings as they are'
  \else
    \warn 'drefyn: statement logging, failed statement logging, duration logging or sampling, pgaudit, auto_explain or pg_stat_statements may record the passwords this file sets, and this role cannot turn them off. Check them, then set DREFYN_BOOTSTRAP_LOG_CHECKED=yes to run anyway'
    select where false \gset
  \endif
\endif

\set drefyn_log_quiet true
