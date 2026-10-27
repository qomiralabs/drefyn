-- Up Migration
alter function app.f() set schema extensions;

-- Down Migration
select 1;
