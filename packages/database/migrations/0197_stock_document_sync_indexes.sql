-- The stable app API's stock document lists (inventory_levels.list,
-- suppliers.list, purchase_orders.list, inventory_transfers.list) page in
-- (updated_at, tie-break) order. Each index serves that order, unfiltered
-- and with the list's equality filter (a level's location, a document's
-- status), so a page walks the index from the cursor instead of sorting the
-- table. A level's tie-break is its key: the SKU, then the location.
CREATE INDEX `inventory_levels_updated_idx` ON `inventory_levels` (`updated_at`,`variant_id`,`location_id`);
--> statement-breakpoint
CREATE INDEX `inventory_levels_location_updated_idx` ON `inventory_levels` (`location_id`,`updated_at`,`variant_id`);
--> statement-breakpoint
CREATE INDEX `inventory_transfers_updated_idx` ON `inventory_transfers` (`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `inventory_transfers_status_updated_idx` ON `inventory_transfers` (`status`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `purchase_orders_updated_idx` ON `purchase_orders` (`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `purchase_orders_status_updated_idx` ON `purchase_orders` (`status`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `suppliers_updated_idx` ON `suppliers` (`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `suppliers_status_updated_idx` ON `suppliers` (`status`,`updated_at`,`id`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (197, '0197_stock_document_sync_indexes', 'e35deb554bbc8ec59a049eddf1f4bead3c8df166206b9bf3f5428a4a6198e9dd');
