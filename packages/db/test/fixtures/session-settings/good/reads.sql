select current_setting('drefyn.organization_id', true);
select nullif(current_setting('drefyn.project_id', true), '')::uuid;
