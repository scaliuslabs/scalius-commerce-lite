-- See ../0224_kits_and_page_offers.sql.
CREATE TABLE "product_page_offers" (
	"product_id" text COLLATE "C" NOT NULL,
	"variant_id" text COLLATE "C" NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("product_id", "variant_id"),
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_page_offers_position_range" CHECK("product_page_offers"."position" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE INDEX "product_page_offers_variant_idx" ON "product_page_offers" ("variant_id");
--> statement-breakpoint
CREATE TABLE "variant_components" (
	"kit_variant_id" text COLLATE "C" NOT NULL,
	"component_variant_id" text COLLATE "C" NOT NULL,
	"quantity" bigint NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("kit_variant_id", "component_variant_id"),
	FOREIGN KEY ("kit_variant_id") REFERENCES "product_variants"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "variant_components_quantity_range" CHECK("variant_components"."quantity" BETWEEN 1 AND 100),
	CONSTRAINT "variant_components_not_self" CHECK("variant_components"."kit_variant_id" <> "variant_components"."component_variant_id"),
	CONSTRAINT "variant_components_position_range" CHECK("variant_components"."position" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE INDEX "variant_components_component_idx" ON "variant_components" ("component_variant_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_component_live_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (SELECT 1 FROM "product_variants" AS component_sku WHERE component_sku."id" = NEW."component_variant_id" AND component_sku."deleted_at" IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_component_missing';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_component_live"
BEFORE INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_component_live_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_not_nested_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "variant_components" AS existing WHERE existing."kit_variant_id" = NEW."component_variant_id")
  OR EXISTS (SELECT 1 FROM "variant_components" AS existing WHERE existing."component_variant_id" = NEW."kit_variant_id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_nested';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_not_nested"
BEFORE INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_not_nested_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_no_gift_card_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (
  SELECT 1 FROM "product_variants" AS kit_sku
  INNER JOIN "products" AS kit_product ON kit_product."id" = kit_sku."product_id"
  WHERE kit_sku."id" IN (NEW."kit_variant_id", NEW."component_variant_id") AND kit_product."is_gift_card" = 1
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_gift_card';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_no_gift_card"
BEFORE INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_no_gift_card_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_limit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT count(*) FROM "variant_components" AS existing WHERE existing."kit_variant_id" = NEW."kit_variant_id") >= 20), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_limit';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_limit"
BEFORE INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_limit_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_kit_holds_no_stock_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (
  SELECT 1 FROM "product_variants" AS kit_sku
  WHERE kit_sku."id" = NEW."kit_variant_id" AND (kit_sku."stock" <> 0 OR kit_sku."reserved_stock" <> 0 OR kit_sku."preorder_stock" <> 0)
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_kit_stock';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_kit_holds_no_stock"
BEFORE INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_kit_holds_no_stock_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kit_variant_id" IS DISTINCT FROM OLD."kit_variant_id" OR NEW."component_variant_id" IS DISTINCT FROM OLD."component_variant_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'variant_components_identity_immutable';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_identity_immutable"
BEFORE UPDATE OF "kit_variant_id", "component_variant_id" ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_identity_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."inventory_movements_never_a_kit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "variant_components" AS kit_part WHERE kit_part."kit_variant_id" = NEW."variant_id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory_movements_kit';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "inventory_movements_never_a_kit"
BEFORE INSERT ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."inventory_movements_never_a_kit_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_page_offers_other_product_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
  SELECT 1 FROM "product_variants" AS offer_sku
  WHERE offer_sku."id" = NEW."variant_id" AND offer_sku."deleted_at" IS NULL AND offer_sku."product_id" <> NEW."product_id"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_page_offers_variant_invalid';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "product_page_offers_other_product"
BEFORE INSERT ON "product_page_offers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_page_offers_other_product_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_page_offers_limit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT count(*) FROM "product_page_offers" AS existing WHERE existing."product_id" = NEW."product_id") >= 20), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_page_offers_limit';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "product_page_offers_limit"
BEFORE INSERT ON "product_page_offers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_page_offers_limit_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_page_offers_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."product_id" IS DISTINCT FROM OLD."product_id" OR NEW."variant_id" IS DISTINCT FROM OLD."variant_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_page_offers_identity_immutable';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "product_page_offers_identity_immutable"
BEFORE UPDATE OF "product_id", "variant_id" ON "product_page_offers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_page_offers_identity_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_variants_kit_holds_no_stock_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."stock" <> 0 OR NEW."reserved_stock" <> 0 OR NEW."preorder_stock" <> 0 OR NEW."track_inventory" = 1)
  AND EXISTS (SELECT 1 FROM "variant_components" AS kit_part WHERE kit_part."kit_variant_id" = NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_variants_kit_stock';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "product_variants_kit_holds_no_stock"
BEFORE UPDATE OF "stock", "reserved_stock", "preorder_stock", "track_inventory" ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_variants_kit_holds_no_stock_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_kit_never_a_gift_card_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."is_gift_card" = 1 AND OLD."is_gift_card" = 0 AND EXISTS (
  SELECT 1 FROM "product_variants" AS kit_sku
  WHERE kit_sku."product_id" = NEW."id"
    AND (EXISTS (SELECT 1 FROM "variant_components" AS as_kit WHERE as_kit."kit_variant_id" = kit_sku."id")
      OR EXISTS (SELECT 1 FROM "variant_components" AS as_part WHERE as_part."component_variant_id" = kit_sku."id"))
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'products_kit_gift_card';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "products_kit_never_a_gift_card"
BEFORE UPDATE OF "is_gift_card" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_kit_never_a_gift_card_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_items_never_a_kit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."variant_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "variant_components" AS kit_part WHERE kit_part."kit_variant_id" = NEW."variant_id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order_items_kit';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_items_never_a_kit"
BEFORE INSERT ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_items_never_a_kit_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_items_never_become_a_kit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."variant_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "variant_components" AS kit_part WHERE kit_part."kit_variant_id" = NEW."variant_id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order_items_kit';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_items_never_become_a_kit"
BEFORE UPDATE OF "variant_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_items_never_become_a_kit_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_checkout_fence_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "checkout_fences" ("scope", "revision") SELECT DISTINCT 'product:' || "fence_source"."product_id", 1 FROM "product_variants" AS "fence_source" WHERE "fence_source"."id" = NEW."kit_variant_id" ON CONFLICT ("scope") DO UPDATE SET "revision" = "checkout_fences"."revision" + 1;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_checkout_fence_insert"
AFTER INSERT ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_checkout_fence_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_checkout_fence_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."position" IS DISTINCT FROM OLD."position"), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "checkout_fences" ("scope", "revision") SELECT DISTINCT 'product:' || "fence_source"."product_id", 1 FROM "product_variants" AS "fence_source" WHERE "fence_source"."id" IN (NEW."kit_variant_id", OLD."kit_variant_id") ON CONFLICT ("scope") DO UPDATE SET "revision" = "checkout_fences"."revision" + 1;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "variant_components_checkout_fence_update"
AFTER UPDATE ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_checkout_fence_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."variant_components_checkout_fence_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "checkout_fences" ("scope", "revision") SELECT DISTINCT 'product:' || "fence_source"."product_id", 1 FROM "product_variants" AS "fence_source" WHERE "fence_source"."id" = OLD."kit_variant_id" ON CONFLICT ("scope") DO UPDATE SET "revision" = "checkout_fences"."revision" + 1;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "variant_components_checkout_fence_delete"
AFTER DELETE ON "variant_components"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."variant_components_checkout_fence_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_variant_components_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."kit_variant_id"), 't:variant_components']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_variant_components_ins"
AFTER INSERT ON "variant_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_variant_components_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_variant_components_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."kit_variant_id"), 't:variant_components']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_variant_components_del"
AFTER DELETE ON "variant_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_variant_components_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_variant_components_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."kit_variant_id"), 't:variant_components']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_variant_components_upd"
AFTER UPDATE ON "variant_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."kit_variant_id" IS DISTINCT FROM NEW."kit_variant_id" OR OLD."component_variant_id" IS DISTINCT FROM NEW."component_variant_id" OR OLD."quantity" IS DISTINCT FROM NEW."quantity" OR OLD."position" IS DISTINCT FROM NEW."position"))
EXECUTE FUNCTION scalius_compat."cdep_variant_components_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_variant_components_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."kit_variant_id"), 't:variant_components']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_variant_components_upd_old"
AFTER UPDATE ON "variant_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."kit_variant_id" IS DISTINCT FROM NEW."kit_variant_id"))
EXECUTE FUNCTION scalius_compat."cdep_variant_components_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_page_offers_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_page_offers']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_page_offers_ins"
AFTER INSERT ON "product_page_offers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_page_offers_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_page_offers_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_page_offers']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_page_offers_del"
AFTER DELETE ON "product_page_offers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_page_offers_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_page_offers_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_page_offers']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_page_offers_upd"
AFTER UPDATE ON "product_page_offers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id" OR OLD."variant_id" IS DISTINCT FROM NEW."variant_id" OR OLD."position" IS DISTINCT FROM NEW."position"))
EXECUTE FUNCTION scalius_compat."cdep_product_page_offers_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_page_offers_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_page_offers']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_page_offers_upd_old"
AFTER UPDATE ON "product_page_offers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id"))
EXECUTE FUNCTION scalius_compat."cdep_product_page_offers_upd_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (224, '0224_kits_and_page_offers', '7cf0ae3969ac5b4c4d44cbbde92afe44811afba46d73ef5c4d38c0ffa7ea1562');
