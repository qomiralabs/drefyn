-- Up Migration
do $body$ begin execute 'drop extension vector'; end $body$;

-- Down Migration
select 1;
