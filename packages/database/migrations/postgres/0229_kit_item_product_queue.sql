-- See ../0229_kit_item_product_queue.sql.
CREATE OR REPLACE FUNCTION scalius_compat."products_kit_items_queue_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."is_gift_card" IS DISTINCT FROM NEW."is_gift_card")
  AND EXISTS (
  SELECT 1 FROM "product_variants" AS queued_sku
  INNER JOIN "variant_components" AS queued_part ON queued_part."component_variant_id" = queued_sku."id"
  WHERE queued_sku."product_id" = NEW."id"
)), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "system_kv" ("key", "value")
  SELECT 'catalog:kit-items:' || queued_sku."id", '1|' FROM "product_variants" AS queued_sku
  WHERE queued_sku."product_id" = NEW."id"
    AND EXISTS (SELECT 1 FROM "variant_components" AS queued_part WHERE queued_part."component_variant_id" = queued_sku."id")
  ON CONFLICT ("key") DO UPDATE SET "value" = (CAST(substr("system_kv"."value", 1, instr("system_kv"."value", '|') - 1) AS INTEGER) + 1) || '|';
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "products_kit_items_queue"
AFTER UPDATE OF "is_active", "deleted_at", "is_gift_card" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_kit_items_queue_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."channel_id" = 'sc_online_store' AND EXISTS (
  SELECT 1 FROM "product_variants" AS queued_sku
  INNER JOIN "variant_components" AS queued_part ON queued_part."component_variant_id" = queued_sku."id"
  WHERE queued_sku."product_id" = NEW."product_id"
)), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "system_kv" ("key", "value")
  SELECT 'catalog:kit-items:' || queued_sku."id", '1|' FROM "product_variants" AS queued_sku
  WHERE queued_sku."product_id" = NEW."product_id"
    AND EXISTS (SELECT 1 FROM "variant_components" AS queued_part WHERE queued_part."component_variant_id" = queued_sku."id")
  ON CONFLICT ("key") DO UPDATE SET "value" = (CAST(substr("system_kv"."value", 1, instr("system_kv"."value", '|') - 1) AS INTEGER) + 1) || '|';
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "product_channel_publications_kit_items_queue_ins"
AFTER INSERT ON "product_channel_publications"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."channel_id" = 'sc_online_store' AND OLD."unpublished_at" IS DISTINCT FROM NEW."unpublished_at" AND EXISTS (
  SELECT 1 FROM "product_variants" AS queued_sku
  INNER JOIN "variant_components" AS queued_part ON queued_part."component_variant_id" = queued_sku."id"
  WHERE queued_sku."product_id" = NEW."product_id"
)), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "system_kv" ("key", "value")
  SELECT 'catalog:kit-items:' || queued_sku."id", '1|' FROM "product_variants" AS queued_sku
  WHERE queued_sku."product_id" = NEW."product_id"
    AND EXISTS (SELECT 1 FROM "variant_components" AS queued_part WHERE queued_part."component_variant_id" = queued_sku."id")
  ON CONFLICT ("key") DO UPDATE SET "value" = (CAST(substr("system_kv"."value", 1, instr("system_kv"."value", '|') - 1) AS INTEGER) + 1) || '|';
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "product_channel_publications_kit_items_queue_upd"
AFTER UPDATE OF "unpublished_at" ON "product_channel_publications"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."channel_id" = 'sc_online_store' AND EXISTS (
  SELECT 1 FROM "product_variants" AS queued_sku
  INNER JOIN "variant_components" AS queued_part ON queued_part."component_variant_id" = queued_sku."id"
  WHERE queued_sku."product_id" = OLD."product_id"
)), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "system_kv" ("key", "value")
  SELECT 'catalog:kit-items:' || queued_sku."id", '1|' FROM "product_variants" AS queued_sku
  WHERE queued_sku."product_id" = OLD."product_id"
    AND EXISTS (SELECT 1 FROM "variant_components" AS queued_part WHERE queued_part."component_variant_id" = queued_sku."id")
  ON CONFLICT ("key") DO UPDATE SET "value" = (CAST(substr("system_kv"."value", 1, instr("system_kv"."value", '|') - 1) AS INTEGER) + 1) || '|';
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "product_channel_publications_kit_items_queue_del"
AFTER DELETE ON "product_channel_publications"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_channel_publications_kit_items_queue_del_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (229, '0229_kit_item_product_queue', '81248dd4d5544992cc618159062f4c10de1875ae960095ee202b8247ed329025');
