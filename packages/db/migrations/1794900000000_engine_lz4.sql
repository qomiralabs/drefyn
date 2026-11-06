-- A 100 KB page stores a tree of about 440 KB, and pglz compressing it twice is the largest single
-- cost in a save's write. lz4 gives about the same size. Only new values use it; old ones stay
-- readable as they are, and nothing is rewritten, so this takes a brief lock and no table scan.

-- Up Migration
alter table app.nodes alter column head_content set compression lz4;
alter table app.node_versions alter column content set compression lz4;

-- Down Migration
alter table app.node_versions alter column content set compression default;
alter table app.nodes alter column head_content set compression default;
