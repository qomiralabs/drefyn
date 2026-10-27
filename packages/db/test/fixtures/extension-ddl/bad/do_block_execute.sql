-- Up Migration
do $$ begin execute 'create extension pg_trgm'; end $$;

-- Down Migration
select 1;
