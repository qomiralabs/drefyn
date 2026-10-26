-- Up Migration
do $$ begin execute 'create table extensions.t (id int)'; end $$;

-- Down Migration
select 1;
