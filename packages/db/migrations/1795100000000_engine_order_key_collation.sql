-- Order keys are made by comparing bytes, so lists must sort them by bytes too. Under a locale
-- collation the pinned image sorts 'aA' before 'a0' and ignores case at first, which would
-- put a node somewhere other than where its key says. Both list indexes rebuild on the new order.

-- Up Migration
alter table app.nodes alter column order_key type text collate "C";

-- Down Migration
alter table app.nodes alter column order_key type text collate "default";
