-- Markets step 3b (docs/MARKETS-DESIGN.md "Step 3b implemented"): shipping
-- zones by region, Shopify's model. A zone serves countries, admin areas and
-- postal-code prefixes (delivery_zone_regions, one zone per region) and
-- Bangladesh delivery locations (delivery_zone_locations, as before). An
-- address belongs to its most specific matching zone: Bangladesh location >
-- postal prefix > admin area > country; an address no zone matches gets no
-- delivery rate. The rates without a zone ("Everywhere else", which served
-- only Bangladesh) become the zone "Bangladesh" (dz_bd, the whole country):
-- the same rates, ids, fees and thresholds for the same addresses. Local
-- pickup stays store-wide (no zone); its revision document is renamed
-- delivery_pickup, and a trigger refuses a live delivery rate without a
-- zone. Agent storefront contexts keep the destination's country, admin
-- area and postal code. Region changes advance the checkout authority fence
-- and the ship cache dependency (generated from
-- packages/shared/src/cache-deps.ts).
CREATE TABLE "delivery_zone_regions" (
	"country_code" text NOT NULL,
	"admin_area" text DEFAULT '' NOT NULL,
	"postal_prefix" text DEFAULT '' NOT NULL,
	"zone_id" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("country_code", "admin_area", "postal_prefix"),
	FOREIGN KEY ("zone_id") REFERENCES "delivery_zones"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "delivery_zone_regions_country_shape" CHECK(length("delivery_zone_regions"."country_code") = 2 AND "delivery_zone_regions"."country_code" !~ '[^A-Z]'),
	CONSTRAINT "delivery_zone_regions_one_kind" CHECK("delivery_zone_regions"."admin_area" = '' OR "delivery_zone_regions"."postal_prefix" = ''),
	CONSTRAINT "delivery_zone_regions_admin_area_shape" CHECK(length("delivery_zone_regions"."admin_area") <= 120 AND "delivery_zone_regions"."admin_area" = trim("delivery_zone_regions"."admin_area")),
	CONSTRAINT "delivery_zone_regions_postal_prefix_shape" CHECK(length("delivery_zone_regions"."postal_prefix") <= 10 AND "delivery_zone_regions"."postal_prefix" !~ '[^A-Z0-9]')
);
--> statement-breakpoint
CREATE INDEX "delivery_zone_regions_zone_idx" ON "delivery_zone_regions" ("zone_id");
--> statement-breakpoint
-- "Everywhere else" served Bangladesh addresses outside every zone: it
-- becomes the zone of the whole of Bangladesh, after the existing zones.
INSERT INTO "delivery_zones" ("id", "name", "sort_order")
SELECT 'dz_bd', 'Bangladesh', coalesce((SELECT max("sort_order") FROM "delivery_zones"), -1) + 1
WHERE EXISTS (SELECT 1 FROM "shipping_methods" WHERE "zone_id" IS NULL AND "kind" = 'delivery' AND "deleted_at" IS NULL);
--> statement-breakpoint
INSERT INTO "delivery_zone_regions" ("country_code", "admin_area", "postal_prefix", "zone_id")
SELECT 'BD', '', '', 'dz_bd' WHERE EXISTS (SELECT 1 FROM "delivery_zones" WHERE "id" = 'dz_bd');
--> statement-breakpoint
UPDATE "shipping_methods" SET "zone_id" = 'dz_bd'
WHERE "zone_id" IS NULL AND "kind" = 'delivery' AND "deleted_at" IS NULL;
--> statement-breakpoint
-- The revision of the store-wide rates now guards local pickup alone.
UPDATE "settings" SET "category" = 'delivery_pickup'
WHERE "category" = 'delivery_everywhere_else' AND "key" = 'document';
--> statement-breakpoint
-- A live delivery rate belongs to a zone: only local pickup is store-wide.
CREATE OR REPLACE FUNCTION scalius_compat."shipping_methods_delivery_zone_required_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" = 'delivery' AND NEW."zone_id" IS NULL AND NEW."deleted_at" IS NULL), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SHIPPING_RATE_ZONE_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "shipping_methods_delivery_zone_required_insert"
BEFORE INSERT ON "shipping_methods"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."shipping_methods_delivery_zone_required_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."shipping_methods_delivery_zone_required_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" = 'delivery' AND NEW."zone_id" IS NULL AND NEW."deleted_at" IS NULL), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SHIPPING_RATE_ZONE_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "shipping_methods_delivery_zone_required_update"
BEFORE UPDATE OF "kind", "zone_id", "deleted_at" ON "shipping_methods"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."shipping_methods_delivery_zone_required_update_fn"();
--> statement-breakpoint
-- A zone's regions decide which rates a buyer gets: every change advances
-- the checkout authority revision (as zone locations do).
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "delivery_zone_regions_checkout_authority_insert"
AFTER INSERT ON "delivery_zone_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "delivery_zone_regions_checkout_authority_update"
AFTER UPDATE ON "delivery_zone_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "delivery_zone_regions_checkout_authority_delete"
AFTER DELETE ON "delivery_zone_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_regions_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_regions_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_regions_ins"
AFTER INSERT ON "delivery_zone_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_regions_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_regions_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_regions_del"
AFTER DELETE ON "delivery_zone_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_regions_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_regions_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_regions_upd"
AFTER UPDATE ON "delivery_zone_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."admin_area" IS DISTINCT FROM NEW."admin_area" OR OLD."postal_prefix" IS DISTINCT FROM NEW."postal_prefix" OR OLD."zone_id" IS DISTINCT FROM NEW."zone_id"))
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_regions_upd_fn"();
--> statement-breakpoint
-- An agent's storefront context prices one destination: its country (null
-- is Bangladesh) and another country's admin area and postal code beside
-- Bangladesh's City/Thana/Area ids.
ALTER TABLE "agent_storefront_contexts" ADD COLUMN "country_code" text CONSTRAINT "agent_storefront_contexts_country_shape" CHECK ("country_code" IS NULL OR (length("country_code") = 2 AND "country_code" !~ '[^A-Z]'));
--> statement-breakpoint
ALTER TABLE "agent_storefront_contexts" ADD COLUMN "admin_area" text;
--> statement-breakpoint
ALTER TABLE "agent_storefront_contexts" ADD COLUMN "postal_code" text;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (114, '0114_shipping_zones', '26615b7089869e68377d7a7b14f7a6d644c01597c0311c81a10d362ee682da22');
