-- Up Migration
create function extensions.f() returns int language sql as $$ select 1 $$;

-- Down Migration
select 1;
