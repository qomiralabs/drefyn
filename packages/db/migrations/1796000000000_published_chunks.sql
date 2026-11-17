-- Retrieval and MCP read published text through the public reader, which has no grant on
-- app.chunks. Publish copies a version's chunks here in the transaction that writes its
-- published_versions row, so a pin names exact text and a half done publish is never seen.
-- The three term tables hold what BM25 needs (chunk count, total length, document frequency
-- and per chunk term frequency) for public current chunks only, so ranking reads a bounded
-- set of postings instead of every tsvector in a project, and no count can reveal a word that
-- appears only on a protected page. Like every published table, each carries the public guard
-- for the public reader and a protected_read policy for the protected reader.

-- Up Migration
-- array_to_string is only stable, so Postgres 18 refuses it in a generated column. Its output
-- for text[] never depends on a setting, which is what immutable promises; a dump and restore
-- test holds that promise.
create function app.heading_text(h text[]) returns text
  language sql immutable strict parallel safe security invoker
  as $$ select pg_catalog.array_to_string(h, ' ') $$;

revoke execute on function app.heading_text(text[]) from public;

-- Only a writer computes the column. Readers read the stored value and need nothing.
grant execute on function app.heading_text(text[]) to drefyn_app;

create table app.published_chunks (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  project_id uuid not null,
  node_id uuid not null,
  version_id uuid not null,
  ord integer not null check (ord >= 0),
  page_path text not null,
  title text not null,
  heading_path text[] not null,
  body text not null,
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  -- No default: a write that forgets it fails instead of guessing.
  visibility text not null check (visibility in ('public', 'protected')),
  is_current boolean not null,
  -- 'simple' because a project's language is not known, and stemming the wrong language
  -- hurts every other one.
  search tsvector generated always as
    (to_tsvector('simple'::regconfig, app.heading_text(heading_path) || ' ' || body)) stored,
  constraint published_chunks_version_ord_key unique (organization_id, project_id, version_id, ord),
  -- Postings point at a chunk with the tenant columns too, so one cannot name another tenant's.
  constraint published_chunks_tenant_id_key unique (organization_id, project_id, id),
  constraint published_chunks_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id),
  -- Retention removes a published version and its chunks together.
  constraint published_chunks_version_fkey
    foreign key (organization_id, project_id, node_id, version_id)
    references app.published_versions (organization_id, project_id, node_id, version_id)
    on delete cascade
);

-- What a page read and the drift check walk: the current text of a project in page order.
create index published_chunks_current
  on app.published_chunks (organization_id, project_id, page_path, ord)
  where is_current;

-- The embeddings read policy matches a vector to published text by hash.
create index published_chunks_hash
  on app.published_chunks (organization_id, project_id, body_sha256);

-- Publish finds the node's current rows to flip without walking the whole project.
create index published_chunks_node
  on app.published_chunks (organization_id, project_id, node_id)
  where is_current;

create table app.published_project_term_totals (
  organization_id uuid not null,
  project_id uuid not null,
  -- Named docs versions add labels later without a type change.
  version_label text not null default 'latest' check (char_length(version_label) between 1 and 100),
  -- Every published table carries the public guard. These hold public chunks only, so the
  -- column can say nothing else; no default, so a write still has to name it.
  visibility text not null
    constraint published_project_term_totals_visibility_check check (visibility = 'public'),
  chunk_count integer not null check (chunk_count >= 0),
  -- Sum of chunk lengths in lexeme positions, the BM25 average length numerator.
  total_length bigint not null check (total_length >= 0),
  constraint published_project_term_totals_pkey
    primary key (organization_id, project_id, version_label),
  constraint published_project_term_totals_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.published_term_stats (
  organization_id uuid not null,
  project_id uuid not null,
  version_label text not null default 'latest' check (char_length(version_label) between 1 and 100),
  lexeme text not null,
  -- Public chunks only, as on the totals.
  visibility text not null
    constraint published_term_stats_visibility_check check (visibility = 'public'),
  -- A lexeme no public chunk holds has no row, rather than a zero.
  df integer not null check (df > 0),
  constraint published_term_stats_pkey
    primary key (organization_id, project_id, version_label, lexeme),
  constraint published_term_stats_project_fkey foreign key (organization_id, project_id)
    references app.projects (organization_id, id)
);

create table app.published_chunk_terms (
  organization_id uuid not null,
  project_id uuid not null,
  version_label text not null default 'latest' check (char_length(version_label) between 1 and 100),
  lexeme text not null,
  chunk_id uuid not null,
  -- Public chunks only, as on the totals.
  visibility text not null
    constraint published_chunk_terms_visibility_check check (visibility = 'public'),
  tf integer not null check (tf > 0),
  -- Copied so scoring never joins the chunk row.
  chunk_length integer not null check (chunk_length > 0),
  -- Covering, so scoring reads postings with index only scans and never visits the heap.
  -- visibility is in it because the public reader's restrictive policy reads it on every row.
  constraint published_chunk_terms_pkey
    primary key (organization_id, project_id, version_label, lexeme, chunk_id)
    include (tf, chunk_length, visibility),
  -- The only foreign key: a page writes thousands of postings, each key costs a check per row,
  -- and the chunk already ties the posting to its project.
  constraint published_chunk_terms_chunk_fkey foreign key (organization_id, project_id, chunk_id)
    references app.published_chunks (organization_id, project_id, id) on delete cascade
);

-- Candidate generation reads a lexeme's postings highest term frequency first.
create index published_chunk_terms_impact
  on app.published_chunk_terms (organization_id, project_id, version_label, lexeme, tf desc, chunk_id)
  include (chunk_length, visibility);

-- Without it every chunk a retention delete removes would scan the postings for its cascade.
create index published_chunk_terms_chunk
  on app.published_chunk_terms (organization_id, project_id, chunk_id);

-- The planner otherwise treats the two tenant columns as independent and expects about one row
-- per tenant, and the chunk foreign key check walks a tenant's rows.
create statistics app.published_chunks_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.published_chunks;
create statistics app.published_chunk_terms_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.published_chunk_terms;
create statistics app.published_term_stats_tenant_stats (ndistinct, dependencies)
  on organization_id, project_id from app.published_term_stats;

alter table app.published_chunks enable row level security;
alter table app.published_chunks force row level security;
create policy tenant_isolation on app.published_chunks to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_chunks for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());
-- Permissive policies are OR'd, so only a restrictive one can keep protected rows out.
create policy published_public_only on app.published_chunks as restrictive
  for select to drefyn_public_reader using (visibility = 'public');
create policy protected_read on app.published_chunks for select to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

alter table app.published_project_term_totals enable row level security;
alter table app.published_project_term_totals force row level security;
create policy tenant_isolation on app.published_project_term_totals to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_project_term_totals for select
  to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());
create policy published_public_only on app.published_project_term_totals as restrictive
  for select to drefyn_public_reader using (visibility = 'public');
create policy protected_read on app.published_project_term_totals for select
  to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

alter table app.published_term_stats enable row level security;
alter table app.published_term_stats force row level security;
create policy tenant_isolation on app.published_term_stats to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_term_stats for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());
create policy published_public_only on app.published_term_stats as restrictive
  for select to drefyn_public_reader using (visibility = 'public');
create policy protected_read on app.published_term_stats for select to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

alter table app.published_chunk_terms enable row level security;
alter table app.published_chunk_terms force row level security;
create policy tenant_isolation on app.published_chunk_terms to drefyn_app
  using (organization_id = app.current_org() and project_id = app.current_project())
  with check (organization_id = app.current_org() and project_id = app.current_project());
create policy published_read on app.published_chunk_terms for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());
create policy published_public_only on app.published_chunk_terms as restrictive
  for select to drefyn_public_reader using (visibility = 'public');
create policy protected_read on app.published_chunk_terms for select to drefyn_protected_reader
  using (organization_id = app.current_org() and project_id = app.current_project());

grant select on app.published_chunks, app.published_project_term_totals,
  app.published_term_stats, app.published_chunk_terms
  to drefyn_public_reader, drefyn_protected_reader;

-- Down Migration
revoke select on app.published_chunks, app.published_project_term_totals,
  app.published_term_stats, app.published_chunk_terms
  from drefyn_public_reader, drefyn_protected_reader;

drop table app.published_chunk_terms;

drop table app.published_term_stats;

drop table app.published_project_term_totals;

drop table app.published_chunks;

drop function app.heading_text(text[]);
