-- Up Migration
create table app.embeddings (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  v vector(3),
  w extensions.vector(3)
);
create index embeddings_v_idx on app.embeddings using hnsw (v vector_cosine_ops);
create index embeddings_w_idx on app.embeddings using hnsw (w extensions.vector_cosine_ops);

-- Down Migration
drop table app.embeddings;
