-- What queryNodes needs from the tables. A type keeps its definition next to its slot map, as a
-- filter is checked against both in one read. Field values get their own column, not a place in
-- the tree, because pages have no fields and a tree is too large to scan. head_fields is the copy
-- an undeclared filter reads, so that scan never touches content. A list takes the list column of
-- a text slot: t and l columns with the same number are one slot, and only one of them is used.

-- Up Migration
alter table app.content_types add column content_schema jsonb
  check (content_schema is null or jsonb_typeof(content_schema) = 'object');

alter table app.node_versions add column fields jsonb not null default '{}'
  check (jsonb_typeof(fields) = 'object');

alter table app.nodes add column head_fields jsonb not null default '{}'
  check (jsonb_typeof(head_fields) = 'object');

alter table app.node_filter_rows
  drop constraint node_filter_rows_pkey,
  add column l1 text[],
  add column l2 text[],
  add column l3 text[],
  add column l4 text[],
  add column l5 text[],
  add constraint node_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, l1, l2, l3, l4, l5, i1, i2, i3, i4, i5, d1, d2);

-- Lists read only the filter row, so a node with no row would vanish from them. force is lifted
-- because the migration role matches no policy.
alter table app.nodes no force row level security;
alter table app.node_filter_rows no force row level security;
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes
  on conflict do nothing;
alter table app.nodes force row level security;
alter table app.node_filter_rows force row level security;

-- One slot being filled or cleared across a type. Work resumes from after_node_id, so a restart
-- repeats at most one batch. started_at marks the one row an organization may have running; the
-- index holds that rule across projects, which no policy can see.
create table app.filter_backfills (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  type_id uuid not null,
  field_id uuid not null,
  slot_column text not null check (slot_column ~ '^([til][1-5]|d[12])$'),
  action text not null check (action in ('fill', 'clear')),
  after_node_id uuid,
  started_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  constraint filter_backfills_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  constraint filter_backfills_type_fkey foreign key (organization_id, project_id, type_id)
    references app.content_types (organization_id, project_id, id)
);

create unique index filter_backfills_one_running on app.filter_backfills (organization_id)
  where started_at is not null and done_at is null;
create index filter_backfills_open on app.filter_backfills (organization_id, project_id, created_at)
  where done_at is null;

alter table app.filter_backfills enable row level security;
alter table app.filter_backfills force row level security;
create policy tenant_isolation on app.filter_backfills to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());

-- Down Migration
drop table app.filter_backfills;

alter table app.node_filter_rows
  drop constraint node_filter_rows_pkey,
  drop column l1,
  drop column l2,
  drop column l3,
  drop column l4,
  drop column l5,
  add constraint node_filter_rows_pkey primary key (organization_id, project_id, type_id, node_id)
    include (t1, t2, t3, t4, t5, i1, i2, i3, i4, i5, d1, d2);

alter table app.nodes drop column head_fields;
alter table app.node_versions drop column fields;
alter table app.content_types drop column content_schema;
