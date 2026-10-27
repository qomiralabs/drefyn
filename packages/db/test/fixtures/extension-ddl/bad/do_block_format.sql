-- Up Migration
do $$ begin execute format('create %s pg_trgm', 'extension'); end $$;

-- Down Migration
select 1;
