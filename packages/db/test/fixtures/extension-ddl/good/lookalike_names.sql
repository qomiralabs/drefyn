-- Up Migration
create table app.extensions_log (id uuid primary key, organization_id uuid not null, extension_name text);
alter table app.extensions_log add column extensions_count int;

-- Down Migration
select 1;
