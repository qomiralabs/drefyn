-- Up Migration
create function app.upgrade() returns void language plpgsql as $$ begin execute 'alter extension vector update'; end $$;

-- Down Migration
select 1;
