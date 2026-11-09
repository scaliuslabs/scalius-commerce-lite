-- An app's own warranty records store-wide: see ../0216_app_warranty_list.sql.
CREATE INDEX "order_item_warranties_app_updated_idx" ON "order_item_warranties" ("app_id",coalesce("voided_at", "created_at"),"id") WHERE "order_item_warranties"."app_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (216, '0216_app_warranty_list', 'c20fb40b10e6e19c009c5d2d2708724ae05ff55039785e433d87920219191235');
