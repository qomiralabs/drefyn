-- Up Migration
-- create extension pg_trgm is a bootstrap step, never a migration.
/* drop extension vector would take every vector column with it */
comment on table app.embeddings is 'built on the vector extension';
select 'create extension pg_trgm' as reminder;

-- Down Migration
select 1;
