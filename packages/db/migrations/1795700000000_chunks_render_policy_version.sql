-- Chunk text is what the render keeps, so a chunk depends on the render policy it was made
-- under, as a published version does. Kept on each row so a policy change can find the chunks
-- to make again. Null on rows written before this, which were never made from the render.
-- Adding a nullable column rewrites nothing and takes a brief lock.

-- Up Migration
alter table app.chunks
  add column render_policy_version integer
    constraint chunks_render_policy_version_check check (render_policy_version >= 1);

-- Down Migration
alter table app.chunks drop column render_policy_version;
