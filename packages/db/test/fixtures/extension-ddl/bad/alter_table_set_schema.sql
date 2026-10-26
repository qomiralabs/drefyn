-- Up Migration
alter table app.notes set schema extensions;

-- Down Migration
select 1;
