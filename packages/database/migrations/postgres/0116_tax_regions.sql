-- Markets step 3c (docs/MARKETS-DESIGN.md "Step 3c implemented"): tax
-- regions, the tax provider and prices_include_tax per market.
--
-- tax_regions: where the merchant collects tax. A country region is the
-- registration; a sub-region (an admin area, a postal prefix or a Bangladesh
-- City/Thana/Area place) needs its country's region. An address with no
-- region of its country pays no tax (Stripe Tax's rule). The most specific
-- region with rates of a line's class applies; a combinable rate also brings
-- the broader regions' rates (tax/region-match.ts). A country region may
-- name a tax provider (an app); otherwise the store-wide one decides
-- (tax_settings.provider_id, the built-in system provider by default).
--
-- Today's rates become Bangladesh regions: a store-wide rate is a rate of
-- the region BD, a City/Thana/Area rate a rate of that place's region,
-- combinable, so the same rates stack for the same addresses as before.
-- tax_rates is rebuilt without its jurisdiction columns; soft-deleted rates
-- (referenced by nothing; orders keep their own copy) are not carried over.
--
-- prices_include_tax moves from tax_settings to every market (all of them
-- carry today's value); checkout and the order's tax snapshot read the
-- order's market. Order tax snapshots keep the jurisdiction (country and
-- region) and the provider. Region and rate writes, and a market's flag,
-- fence priced checkouts; the cache dependency triggers are generated from
-- packages/shared/src/cache-deps.ts.
CREATE TABLE "tax_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"admin_area" text DEFAULT '' NOT NULL,
	"postal_prefix" text DEFAULT '' NOT NULL,
	"place_type" text,
	"place_id" text,
	"provider_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "tax_regions_country_shape" CHECK(length("tax_regions"."country_code") = 2 AND "tax_regions"."country_code" !~ '[^A-Z]'),
	CONSTRAINT "tax_regions_admin_area_shape" CHECK(length("tax_regions"."admin_area") <= 120 AND "tax_regions"."admin_area" = trim("tax_regions"."admin_area")),
	CONSTRAINT "tax_regions_postal_prefix_shape" CHECK(length("tax_regions"."postal_prefix") <= 10 AND "tax_regions"."postal_prefix" !~ '[^A-Z0-9]'),
	CONSTRAINT "tax_regions_one_kind" CHECK(("tax_regions"."admin_area" = '' OR "tax_regions"."postal_prefix" = '') AND ("tax_regions"."place_id" IS NULL OR ("tax_regions"."admin_area" = '' AND "tax_regions"."postal_prefix" = '' AND "tax_regions"."country_code" = 'BD'))),
	CONSTRAINT "tax_regions_place_shape" CHECK(("tax_regions"."place_type" IS NULL AND "tax_regions"."place_id" IS NULL) OR ("tax_regions"."place_type" IN ('city', 'zone', 'area') AND "tax_regions"."place_id" IS NOT NULL AND length("tax_regions"."place_id") BETWEEN 1 AND 180)),
	CONSTRAINT "tax_regions_provider_country_only" CHECK("tax_regions"."provider_id" IS NULL OR ("tax_regions"."admin_area" = '' AND "tax_regions"."postal_prefix" = '' AND "tax_regions"."place_id" IS NULL AND ("tax_regions"."provider_id" = 'system' OR (length("tax_regions"."provider_id") BETWEEN 3 AND 120 AND "tax_regions"."provider_id" LIKE '_%:_%')))),
	CONSTRAINT "tax_regions_version_positive" CHECK("tax_regions"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_regions_scope_unique" ON "tax_regions" ("country_code", "admin_area", "postal_prefix", coalesce("place_id", ''));
--> statement-breakpoint
-- A sub-region needs its country's region; a region's scope never changes
-- (another scope is another region); a country region with sub-regions
-- cannot be deleted before them.
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_country_required_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."admin_area" <> '' OR NEW."postal_prefix" <> '' OR NEW."place_id" IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM "tax_regions" AS "country_region" WHERE "country_region"."country_code" = NEW."country_code" AND "country_region"."admin_area" = '' AND "country_region"."postal_prefix" = '' AND "country_region"."place_id" IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAX_REGION_COUNTRY_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_country_required"
BEFORE INSERT ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_country_required_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_scope_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."country_code" IS DISTINCT FROM OLD."country_code" OR NEW."admin_area" IS DISTINCT FROM OLD."admin_area" OR NEW."postal_prefix" IS DISTINCT FROM OLD."postal_prefix" OR NEW."place_type" IS DISTINCT FROM OLD."place_type" OR NEW."place_id" IS DISTINCT FROM OLD."place_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAX_REGION_SCOPE_IMMUTABLE';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_scope_immutable"
BEFORE UPDATE OF "country_code", "admin_area", "postal_prefix", "place_type", "place_id" ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_scope_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_country_delete_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."admin_area" = '' AND OLD."postal_prefix" = '' AND OLD."place_id" IS NULL AND EXISTS (SELECT 1 FROM "tax_regions" AS "sub_region" WHERE "sub_region"."country_code" = OLD."country_code" AND ("sub_region"."admin_area" <> '' OR "sub_region"."postal_prefix" <> '' OR "sub_region"."place_id" IS NOT NULL))), false) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAX_REGION_HAS_SUBREGIONS';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_country_delete_guard"
BEFORE DELETE ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_country_delete_guard_fn"();
--> statement-breakpoint
-- Today's rates are Bangladesh rates: the region BD, and one region per
-- City/Thana/Area a live rate names.
INSERT INTO "tax_regions" ("id", "country_code")
SELECT 'txreg_bd', 'BD' WHERE EXISTS (SELECT 1 FROM "tax_rates" WHERE "deleted_at" IS NULL);
--> statement-breakpoint
INSERT INTO "tax_regions" ("id", "country_code", "place_type", "place_id")
SELECT 'txreg_bd_' || "jurisdiction_id", 'BD', min("jurisdiction_type"), "jurisdiction_id"
FROM "tax_rates"
WHERE "deleted_at" IS NULL AND "jurisdiction_type" IN ('city', 'zone', 'area')
GROUP BY "jurisdiction_id";
--> statement-breakpoint
-- tax_rates loses its jurisdiction columns: the generated cache triggers that
-- name them go first and are reinstalled below. Soft-deleted rates are not
-- carried over (nothing references them; orders keep their own copy).
DROP TRIGGER IF EXISTS "cdep_tax_rates_ins" ON "tax_rates";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_tax_rates_del" ON "tax_rates";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_tax_rates_upd" ON "tax_rates";
--> statement-breakpoint
DELETE FROM "tax_rates" WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "tax_region_id" text;
--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "combinable" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- A store-wide rate stays alone in the region BD; a place's rate combines
-- with the broader regions' rates, as every matching rate stacked before.
UPDATE "tax_rates" SET "tax_region_id" = 'txreg_bd', "combinable" = 0 WHERE "jurisdiction_type" = 'all';
--> statement-breakpoint
UPDATE "tax_rates" SET "tax_region_id" = 'txreg_bd_' || "jurisdiction_id", "combinable" = 1 WHERE "jurisdiction_type" IN ('city', 'zone', 'area');
--> statement-breakpoint
ALTER TABLE "tax_rates" ALTER COLUMN "tax_region_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tax_rates" DROP CONSTRAINT IF EXISTS "tax_rates_jurisdiction_shape";
--> statement-breakpoint
ALTER TABLE "tax_rates" DROP CONSTRAINT IF EXISTS "tax_rates_jurisdiction_label_length";
--> statement-breakpoint
DROP INDEX IF EXISTS "tax_rates_jurisdiction_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "tax_rates_class_active_priority_idx";
--> statement-breakpoint
ALTER TABLE "tax_rates" DROP COLUMN "jurisdiction_type", DROP COLUMN "jurisdiction_id", DROP COLUMN "jurisdiction_label", DROP COLUMN "deleted_at";
--> statement-breakpoint
CREATE INDEX "tax_rates_class_active_priority_idx" ON "tax_rates" ("tax_class_id", "is_active", "priority");
--> statement-breakpoint
CREATE INDEX "tax_rates_region_idx" ON "tax_rates" ("tax_region_id");
--> statement-breakpoint
-- The foreign key goes on after the backfill, so no deferred check is pending
-- while the table is altered.
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_region_id_tax_regions_id_fk" FOREIGN KEY ("tax_region_id") REFERENCES "tax_regions"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_rates_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_rates']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_rates_ins"
AFTER INSERT ON "tax_rates"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_tax_rates_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_rates_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_rates']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_rates_del"
AFTER DELETE ON "tax_rates"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_tax_rates_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_rates_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_rates']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_rates_upd"
AFTER UPDATE ON "tax_rates"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."tax_class_id" IS DISTINCT FROM NEW."tax_class_id" OR OLD."tax_region_id" IS DISTINCT FROM NEW."tax_region_id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."rate_bps" IS DISTINCT FROM NEW."rate_bps" OR OLD."priority" IS DISTINCT FROM NEW."priority" OR OLD."is_compound" IS DISTINCT FROM NEW."is_compound" OR OLD."combinable" IS DISTINCT FROM NEW."combinable" OR OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"))
EXECUTE FUNCTION scalius_compat."cdep_tax_rates_upd_fn"();
--> statement-breakpoint
-- A region decides which rates and which provider apply: every change fences
-- priced checkouts.
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_checkout_authority_insert"
AFTER INSERT ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_checkout_authority_update"
AFTER UPDATE ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_regions_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "tax_regions_checkout_authority_delete"
AFTER DELETE ON "tax_regions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."tax_regions_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_regions_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_regions_ins"
AFTER INSERT ON "tax_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_tax_regions_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_regions_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_regions_del"
AFTER DELETE ON "tax_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_tax_regions_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_regions_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_regions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_regions_upd"
AFTER UPDATE ON "tax_regions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."admin_area" IS DISTINCT FROM NEW."admin_area" OR OLD."postal_prefix" IS DISTINCT FROM NEW."postal_prefix" OR OLD."place_type" IS DISTINCT FROM NEW."place_type" OR OLD."place_id" IS DISTINCT FROM NEW."place_id" OR OLD."provider_id" IS DISTINCT FROM NEW."provider_id"))
EXECUTE FUNCTION scalius_compat."cdep_tax_regions_upd_fn"();
--> statement-breakpoint
-- Every market carries today's store-wide flag; it then leaves tax_settings.
ALTER TABLE "markets" ADD COLUMN "prices_include_tax" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "markets" SET "prices_include_tax" = coalesce((SELECT "prices_include_tax" FROM "tax_settings" WHERE "id" = 'default'), 0);
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion or a country's market changed reviews again.
CREATE OR REPLACE FUNCTION scalius_compat."markets_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."price_increment_minor" IS DISTINCT FROM OLD."price_increment_minor" OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."prices_include_tax" IS DISTINCT FROM OLD."prices_include_tax"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_tax_settings_upd" ON "tax_settings";
--> statement-breakpoint
ALTER TABLE "tax_settings" DROP COLUMN "prices_include_tax";
--> statement-breakpoint
ALTER TABLE "tax_settings" ADD COLUMN "provider_id" text DEFAULT 'system' NOT NULL CONSTRAINT "tax_settings_provider_shape" CHECK ("provider_id" = 'system' OR (length("provider_id") BETWEEN 3 AND 120 AND "provider_id" LIKE '_%:_%'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_tax_settings_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tax', 't:tax_settings']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_tax_settings_upd"
AFTER UPDATE ON "tax_settings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."enabled" IS DISTINCT FROM NEW."enabled" OR OLD."tax_shipping" IS DISTINCT FROM NEW."tax_shipping" OR OLD."default_tax_class_id" IS DISTINCT FROM NEW."default_tax_class_id" OR OLD."shipping_tax_class_id" IS DISTINCT FROM NEW."shipping_tax_class_id" OR OLD."display_label" IS DISTINCT FROM NEW."display_label" OR OLD."provider_id" IS DISTINCT FROM NEW."provider_id" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"))
EXECUTE FUNCTION scalius_compat."cdep_tax_settings_upd_fn"();
--> statement-breakpoint
-- Order tax snapshots keep the jurisdiction and the provider; lines placed
-- before this migration have no recorded jurisdiction.
ALTER TABLE "order_item_tax_snapshots" ADD COLUMN "country_code" text;
--> statement-breakpoint
ALTER TABLE "order_item_tax_snapshots" ADD COLUMN "tax_region_id" text;
--> statement-breakpoint
ALTER TABLE "order_item_tax_snapshots" ADD COLUMN "provider_id" text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_tax_snapshots" ADD COLUMN "provider_id" text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_tax_snapshots" ADD COLUMN "provider_calculation_id" text;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (116, '0116_tax_regions', '53d7b81d453e5b766329f75c5ad260282fb3b1e2aabd2295904112ea0e887410');
