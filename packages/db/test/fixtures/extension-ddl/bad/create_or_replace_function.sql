-- Up Migration
create or replace function extensions.g() returns int language sql as $$ select 2 $$;

-- Down Migration
select 1;
