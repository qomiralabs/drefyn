-- Up Migration
create function app.add_one(n int) returns int language sql immutable as $$ select n + 1 $$;
do $$ begin execute 'select 1'; end $$;

-- Down Migration
select 1;
