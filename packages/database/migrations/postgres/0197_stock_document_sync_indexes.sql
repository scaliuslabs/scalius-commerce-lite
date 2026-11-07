-- The sync lists' order: see ../0197_stock_document_sync_indexes.sql.
CREATE INDEX "inventory_levels_updated_idx" ON "inventory_levels" ("updated_at","variant_id","location_id");
--> statement-breakpoint
CREATE INDEX "inventory_levels_location_updated_idx" ON "inventory_levels" ("location_id","updated_at","variant_id");
--> statement-breakpoint
CREATE INDEX "inventory_transfers_updated_idx" ON "inventory_transfers" ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "inventory_transfers_status_updated_idx" ON "inventory_transfers" ("status","updated_at","id");
--> statement-breakpoint
CREATE INDEX "inventory_transfers_origin_updated_idx" ON "inventory_transfers" ("origin_location_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "inventory_transfers_destination_updated_idx" ON "inventory_transfers" ("destination_location_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_updated_idx" ON "purchase_orders" ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_status_updated_idx" ON "purchase_orders" ("status","updated_at","id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_updated_idx" ON "purchase_orders" ("supplier_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_destination_updated_idx" ON "purchase_orders" ("destination_location_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "suppliers_updated_idx" ON "suppliers" ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "suppliers_status_updated_idx" ON "suppliers" ("status","updated_at","id");
--> statement-breakpoint
CREATE INDEX "promotions_updated_idx" ON "promotions" ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "promotions_status_updated_idx" ON "promotions" ("status","updated_at","id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (197, '0197_stock_document_sync_indexes', 'd2c1d833cc2f38d4c99714d83403fd26ef40aac119be2ba0ff837a83fd9a8668');
