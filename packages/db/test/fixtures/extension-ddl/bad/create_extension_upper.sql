-- Up Migration
CREATE EXTENSION IF NOT EXISTS "pg_trgm" SCHEMA extensions;

-- Down Migration
select 1;
