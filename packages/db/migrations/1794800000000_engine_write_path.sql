-- What the save path relies on. History becomes append only for drefyn_app. Keys that named a
-- parent only by tenant now name the pair, so a node's head is a version of that node and a
-- filter row has its node's type. A count per organization makes a node limit exact, as project
-- context cannot see the rows of other projects.

-- Up Migration
revoke update, delete on app.node_versions from drefyn_app;

alter table app.content_types
  add constraint content_types_id_family_key unique (organization_id, project_id, id, family);

-- The same index, made unique, so a filter row key can point at it and no save writes one more.
drop index app.nodes_type;
alter table app.nodes
  add constraint nodes_type unique (organization_id, project_id, type_id, id);

-- Nothing points at the shorter key after this, and a version write should not pay for it.
alter table app.node_versions
  add constraint node_versions_node_id_key unique (organization_id, project_id, node_id, id);

alter table app.nodes
  drop constraint nodes_type_fkey,
  drop constraint nodes_head_version_fkey,
  drop constraint nodes_published_version_fkey;
alter table app.node_versions drop constraint node_versions_parent_version_fkey;
alter table app.node_filter_rows
  drop constraint node_filter_rows_type_fkey,
  drop constraint node_filter_rows_node_fkey;
alter table app.chunks
  drop constraint chunks_node_fkey,
  drop constraint chunks_version_fkey;
alter table app.engine_outbox
  drop constraint engine_outbox_node_fkey,
  drop constraint engine_outbox_version_fkey;
alter table app.node_versions drop constraint node_versions_tenant_id_key;

alter table app.nodes
  add constraint nodes_type_fkey foreign key (organization_id, project_id, type_id, family)
    references app.content_types (organization_id, project_id, id, family),
  add constraint nodes_head_version_fkey
    foreign key (organization_id, project_id, id, head_version_id)
    references app.node_versions (organization_id, project_id, node_id, id),
  add constraint nodes_published_version_fkey
    foreign key (organization_id, project_id, id, published_version_id)
    references app.node_versions (organization_id, project_id, node_id, id);

alter table app.node_versions
  add constraint node_versions_parent_version_fkey
    foreign key (organization_id, project_id, node_id, parent_version_id)
    references app.node_versions (organization_id, project_id, node_id, id);

-- Each of these names its node and implies the shorter key it replaces.
alter table app.node_filter_rows
  add constraint node_filter_rows_node_fkey
    foreign key (organization_id, project_id, type_id, node_id)
    references app.nodes (organization_id, project_id, type_id, id);

alter table app.chunks
  add constraint chunks_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.node_versions (organization_id, project_id, node_id, id);

alter table app.engine_outbox
  add constraint engine_outbox_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.node_versions (organization_id, project_id, node_id, id);

-- Whole organization, since limits are. Written in the same transaction as the node, and its row
-- lock is what keeps two creates at the limit from both passing.
create table app.organization_node_counts (
  organization_id uuid not null references app.organizations (organization_id),
  family text not null check (family in ('docs_page', 'studio_item', 'status_component', 'status_incident', 'status_incident_update', 'status_maintenance', 'status_postmortem')),
  nodes bigint not null default 0 check (nodes >= 0),
  constraint organization_node_counts_pkey primary key (organization_id, family)
);

alter table app.organization_node_counts enable row level security;
alter table app.organization_node_counts force row level security;
create policy tenant_isolation on app.organization_node_counts to drefyn_app
  using (organization_id = app.current_org())
  with check (organization_id = app.current_org());

-- Down Migration
drop table app.organization_node_counts;

alter table app.engine_outbox drop constraint engine_outbox_version_fkey;
alter table app.chunks drop constraint chunks_version_fkey;
alter table app.node_filter_rows drop constraint node_filter_rows_node_fkey;
alter table app.node_versions drop constraint node_versions_parent_version_fkey;
alter table app.nodes
  drop constraint nodes_type_fkey,
  drop constraint nodes_head_version_fkey,
  drop constraint nodes_published_version_fkey;

alter table app.node_versions
  add constraint node_versions_tenant_id_key unique (organization_id, project_id, id);

alter table app.nodes
  add constraint nodes_type_fkey foreign key (organization_id, project_id, type_id)
    references app.content_types (organization_id, project_id, id),
  add constraint nodes_head_version_fkey
    foreign key (organization_id, project_id, head_version_id)
    references app.node_versions (organization_id, project_id, id),
  add constraint nodes_published_version_fkey
    foreign key (organization_id, project_id, published_version_id)
    references app.node_versions (organization_id, project_id, id);

alter table app.node_versions
  add constraint node_versions_parent_version_fkey
    foreign key (organization_id, project_id, parent_version_id)
    references app.node_versions (organization_id, project_id, id);

alter table app.node_filter_rows
  add constraint node_filter_rows_type_fkey foreign key (organization_id, project_id, type_id)
    references app.content_types (organization_id, project_id, id),
  add constraint node_filter_rows_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id);

alter table app.chunks
  add constraint chunks_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id),
  add constraint chunks_version_fkey foreign key (organization_id, project_id, version_id)
    references app.node_versions (organization_id, project_id, id);

alter table app.engine_outbox
  add constraint engine_outbox_node_fkey foreign key (organization_id, project_id, node_id)
    references app.nodes (organization_id, project_id, id),
  add constraint engine_outbox_version_fkey foreign key (organization_id, project_id, version_id)
    references app.node_versions (organization_id, project_id, id);

alter table app.node_versions drop constraint node_versions_node_id_key;

alter table app.nodes drop constraint nodes_type;
create index nodes_type on app.nodes (organization_id, project_id, type_id, id);

alter table app.content_types drop constraint content_types_id_family_key;

grant update, delete on app.node_versions to drefyn_app;
