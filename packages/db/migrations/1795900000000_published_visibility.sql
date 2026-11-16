-- Protected pages have to be unreachable from public paths the way drafts are: by the
-- database, not by a filter someone might forget. Every published row now says whether it is
-- public or protected, the public reader gets a restrictive policy that keeps only public
-- rows, and a separate role reads both for readers a grant vouches for. Permissive policies
-- are OR'd, so a second permissive rule could never narrow published_read; it has to be
-- restrictive.

-- Up Migration
-- Null means the node follows whatever its site or parent says. Setting it comes later.
alter table app.nodes add column visibility_override text
  constraint nodes_visibility_override_check
    check (visibility_override in ('public', 'protected'));

-- Rows published before this column existed were already readable by the public reader, so
-- they start public and nothing that was visible disappears. The default goes straight after,
-- so every later write has to name the visibility or fail.
alter table app.published_versions add column visibility text not null default 'public'
  constraint published_versions_visibility_check check (visibility in ('public', 'protected'));
alter table app.published_versions alter column visibility drop default;

alter table app.published_filter_rows add column visibility text not null default 'public'
  constraint published_filter_rows_visibility_check
    check (visibility in ('public', 'protected'));
alter table app.published_filter_rows alter column visibility drop default;

-- Public lists filter and sort on the covering key alone. The restrictive policy reads
-- visibility on every row, so it joins the key, or each public list would go to the heap.
alter table app.published_filter_rows
  drop constraint published_filter_rows_pkey,
  add constraint published_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, l1, l2, l3, l4, l5, i1, i2, i3, i4, i5, d1, d2, visibility);

create policy published_public_only on app.published_versions as restrictive
  for select to drefyn_public_reader using (visibility = 'public');
create policy published_public_only on app.published_filter_rows as restrictive
  for select to drefyn_public_reader using (visibility = 'public');

-- Same tenant rule as the public reader, without the visibility guard. Nothing else: no draft
-- table, no write, no function beyond the two context readers.
grant usage on schema app to drefyn_protected_reader;
grant execute on function app.current_org(), app.current_project() to drefyn_protected_reader;
grant select on app.published_versions, app.published_filter_rows to drefyn_protected_reader;
create policy protected_read on app.published_versions for select to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());
create policy protected_read on app.published_filter_rows for select to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
-- Dropping the column is the one step that could expose protected content. A real rollback
-- needs every row made public by a person first; this only exists so the migration reverts.
drop policy protected_read on app.published_filter_rows;
drop policy protected_read on app.published_versions;
revoke select on app.published_versions, app.published_filter_rows from drefyn_protected_reader;
revoke execute on function app.current_org(), app.current_project() from drefyn_protected_reader;
revoke usage on schema app from drefyn_protected_reader;

drop policy published_public_only on app.published_filter_rows;
drop policy published_public_only on app.published_versions;

alter table app.published_filter_rows
  drop constraint published_filter_rows_pkey,
  add constraint published_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, l1, l2, l3, l4, l5, i1, i2, i3, i4, i5, d1, d2);
alter table app.published_filter_rows drop column visibility;
alter table app.published_versions drop column visibility;

alter table app.nodes drop column visibility_override;
