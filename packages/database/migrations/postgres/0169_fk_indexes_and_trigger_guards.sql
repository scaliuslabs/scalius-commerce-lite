-- Foreign-key child indexes: see ../0169_fk_indexes_and_trigger_guards.sql.
-- Its FTS5 update guards are D1-only (search_fts_terms triggers are guarded).
DROP INDEX "order_holds_open_idx";
--> statement-breakpoint
CREATE INDEX "order_holds_order_idx" ON "order_holds" ("order_id","released_at");
--> statement-breakpoint
DROP INDEX "order_return_lines_order_item_idx";
--> statement-breakpoint
CREATE INDEX "order_return_lines_order_item_idx" ON "order_return_lines" ("order_item_id");
--> statement-breakpoint
DROP INDEX "promotion_redemptions_customer_idx";
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_customer_idx" ON "promotion_redemptions" ("customer_id","promotion_id","created_at");
--> statement-breakpoint
CREATE INDEX "product_facet_values_variant_idx" ON "product_facet_values" ("variant_id") WHERE "product_facet_values"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "order_return_receipt_lines_variant_idx" ON "order_return_receipt_lines" ("variant_id") WHERE "order_return_receipt_lines"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "inventory_transfer_movements_variant_idx" ON "inventory_transfer_movements" ("variant_id");
--> statement-breakpoint
CREATE INDEX "inventory_transfer_movements_line_idx" ON "inventory_transfer_movements" ("transfer_line_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_receipt_lines_line_idx" ON "purchase_order_receipt_lines" ("purchase_order_line_id");
--> statement-breakpoint
CREATE INDEX "product_reviews_variant_idx" ON "product_reviews" ("variant_id") WHERE "product_reviews"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "digital_licence_keys_entitlement_idx" ON "digital_licence_keys" ("entitlement_id") WHERE "digital_licence_keys"."entitlement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "gift_card_transactions_order_payment_idx" ON "gift_card_transactions" ("order_payment_id") WHERE "gift_card_transactions"."order_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "gift_cards_source_order_item_idx" ON "gift_cards" ("source_order_item_id") WHERE "gift_cards"."source_order_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "warranty_claims_warranty_idx" ON "warranty_claims" ("warranty_id");
--> statement-breakpoint
CREATE INDEX "warranty_claims_order_item_idx" ON "warranty_claims" ("order_item_id");
--> statement-breakpoint
-- A SKU's band triggers read the store's default low-stock level once per
-- update instead of at every use (up to four settings JSON parses on every
-- stock write). Same guards, same keys; generated from packages/shared/src/
-- cache-deps.ts by packages/database/scripts/cache-dep-triggers.ts.
DROP TRIGGER IF EXISTS "cdep_product_variants_band" ON "product_variants";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_variants_band_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT (CASE WHEN OLD."track_inventory" = 0 THEN 3 WHEN (OLD."stock" - OLD."reserved_stock") <= 0 THEN 0 WHEN COALESCE(COALESCE(OLD."low_stock_threshold", band_store.store_default), 0) > 0 AND (OLD."stock" - OLD."reserved_stock") <= COALESCE(OLD."low_stock_threshold", band_store.store_default) THEN 1 ELSE 2 END) <> (CASE WHEN NEW."track_inventory" = 0 THEN 3 WHEN (NEW."stock" - NEW."reserved_stock") <= 0 THEN 0 WHEN COALESCE(COALESCE(NEW."low_stock_threshold", band_store.store_default), 0) > 0 AND (NEW."stock" - NEW."reserved_stock") <= COALESCE(NEW."low_stock_threshold", band_store.store_default) THEN 1 ELSE 2 END) FROM (SELECT (SELECT CAST(json_extract("value", '$.defaultLowStockThreshold') AS bigint) FROM "settings" WHERE "category" = 'inventory' AND "key" = 'document' AND json_valid("value")) AS store_default) AS band_store)), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_variants']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_variants_band"
AFTER UPDATE ON "product_variants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."stock" IS DISTINCT FROM NEW."stock" OR OLD."reserved_stock" IS DISTINCT FROM NEW."reserved_stock" OR OLD."track_inventory" IS DISTINCT FROM NEW."track_inventory" OR OLD."low_stock_threshold" IS DISTINCT FROM NEW."low_stock_threshold"))
EXECUTE FUNCTION scalius_compat."cdep_product_variants_band_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_product_variants_band_old" ON "product_variants";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_variants_band_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT (CASE WHEN OLD."track_inventory" = 0 THEN 3 WHEN (OLD."stock" - OLD."reserved_stock") <= 0 THEN 0 WHEN COALESCE(COALESCE(OLD."low_stock_threshold", band_store.store_default), 0) > 0 AND (OLD."stock" - OLD."reserved_stock") <= COALESCE(OLD."low_stock_threshold", band_store.store_default) THEN 1 ELSE 2 END) <> (CASE WHEN NEW."track_inventory" = 0 THEN 3 WHEN (NEW."stock" - NEW."reserved_stock") <= 0 THEN 0 WHEN COALESCE(COALESCE(NEW."low_stock_threshold", band_store.store_default), 0) > 0 AND (NEW."stock" - NEW."reserved_stock") <= COALESCE(NEW."low_stock_threshold", band_store.store_default) THEN 1 ELSE 2 END) FROM (SELECT (SELECT CAST(json_extract("value", '$.defaultLowStockThreshold') AS bigint) FROM "settings" WHERE "category" = 'inventory' AND "key" = 'document' AND json_valid("value")) AS store_default) AS band_store)), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_variants']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_variants_band_old"
AFTER UPDATE ON "product_variants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id") AND (OLD."stock" IS DISTINCT FROM NEW."stock" OR OLD."reserved_stock" IS DISTINCT FROM NEW."reserved_stock" OR OLD."track_inventory" IS DISTINCT FROM NEW."track_inventory" OR OLD."low_stock_threshold" IS DISTINCT FROM NEW."low_stock_threshold"))
EXECUTE FUNCTION scalius_compat."cdep_product_variants_band_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (169, '0169_fk_indexes_and_trigger_guards', '1a3adbac4726960c9bab33d5e44dcb86e6aa387d5ceb4b756a2a0532010ad47f');
