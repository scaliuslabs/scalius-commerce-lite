-- The place directory (docs/PLACES.md): delivery_locations, a Bangladesh-only
-- City/Thana/Area tree, becomes places, one tree of numbered levels for any
-- country. Every row keeps its id, so zones, tax regions, customer and order
-- addresses (city/zone/area ids) and courier mappings still point at it.
--
-- - country_code is BD for every row; level comes from type (city 1, thana
--   2, area 3). Bangladesh names its levels City, Thana and Area
--   (@scalius/shared/places).
-- - source, source_key, source_version and source_active belong to dataset
--   imports (delivery/places-import.ts); rows carried over have none.
-- - A parent is one level up in the same country (a trigger refuses another
--   parent). Active names stay unique among a country's top places and among
--   a place's children of one level, as before.
-- - delivery_zone_locations is rebuilt to reference places (SQLite keeps a
--   foreign key's table name); its rows, triggers and index are unchanged.
-- - Checkout is fenced when a place's name, parent, level, country, status
--   or deletion changes (import bookkeeping alone fences nothing); the cache
--   dependency triggers are generated from packages/shared/src/cache-deps.ts.
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"level" bigint NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"external_ids" text NOT NULL,
	"metadata" text NOT NULL,
	"is_active" bigint DEFAULT 1 NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"source" text,
	"source_key" text,
	"source_version" text,
	"source_active" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"deleted_at" bigint,
	FOREIGN KEY ("parent_id") REFERENCES "places"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "places_country_shape" CHECK(length("places"."country_code") = 2 AND "places"."country_code" !~ '[^A-Z]'),
	CONSTRAINT "places_level_range" CHECK("places"."level" BETWEEN 1 AND 4)
);
--> statement-breakpoint
-- The indexes come before the rows: PostgreSQL refuses an index on a table
-- with pending (deferred foreign key) trigger events.
CREATE INDEX "places_parent_id_idx" ON "places" ("parent_id");
--> statement-breakpoint
CREATE INDEX "places_country_level_idx" ON "places" ("country_code","level");
--> statement-breakpoint
CREATE UNIQUE INDEX "places_country_source_key_uidx" ON "places" ("country_code","source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "places_active_root_name_uidx" ON "places" ("country_code",lower(trim("name"))) WHERE "places"."deleted_at" IS NULL AND "places"."is_active" = 1 AND "places"."parent_id" IS NULL AND "places"."level" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "places_active_child_name_uidx" ON "places" ("parent_id","level",lower(trim("name"))) WHERE "places"."deleted_at" IS NULL AND "places"."is_active" = 1 AND "places"."parent_id" IS NOT NULL;
--> statement-breakpoint
-- Every place carries over with its id: Bangladesh, its level from its type.
INSERT INTO "places" ("id", "country_code", "level", "parent_id", "name", "external_ids", "metadata", "is_active", "sort_order", "created_at", "updated_at", "deleted_at")
SELECT "id", 'BD', CASE "type" WHEN 'city' THEN 1 WHEN 'zone' THEN 2 ELSE 3 END, "parent_id", "name", "external_ids", "metadata", "is_active", "sort_order", "created_at", "updated_at", "deleted_at"
FROM "delivery_locations";
--> statement-breakpoint
-- Zone places reference places (PostgreSQL moves the foreign key in place).
ALTER TABLE "delivery_zone_locations" DROP CONSTRAINT "delivery_zone_locations_location_id_fkey";
--> statement-breakpoint
ALTER TABLE "delivery_zone_locations" ADD FOREIGN KEY ("location_id") REFERENCES "places"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_delivery_zone_locations_ins" ON "delivery_zone_locations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_locations_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_locations_ins"
AFTER INSERT ON "delivery_zone_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_locations_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_delivery_zone_locations_del" ON "delivery_zone_locations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_locations_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_locations_del"
AFTER DELETE ON "delivery_zone_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_locations_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_delivery_zone_locations_upd" ON "delivery_zone_locations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_delivery_zone_locations_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:delivery_zone_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_delivery_zone_locations_upd"
AFTER UPDATE ON "delivery_zone_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."location_id" IS DISTINCT FROM NEW."location_id" OR OLD."zone_id" IS DISTINCT FROM NEW."zone_id"))
EXECUTE FUNCTION scalius_compat."cdep_delivery_zone_locations_upd_fn"();
--> statement-breakpoint
-- The old table goes with its indexes and triggers, then its trigger functions.
DROP TABLE IF EXISTS "delivery_locations";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_delivery_locations_ins_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_delivery_locations_del_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_delivery_locations_upd_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."delivery_locations_checkout_authority_insert_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."delivery_locations_checkout_authority_update_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."delivery_locations_checkout_authority_delete_fn"();
--> statement-breakpoint
-- A top place has no parent; any other place's parent is one level up in the
-- same country. Clearing a parent (a hard-deleted parent's ON DELETE SET
-- NULL) is allowed.
CREATE OR REPLACE FUNCTION scalius_compat."places_parent_guard_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."level" = 1 AND NEW."parent_id" IS NOT NULL) OR (NEW."level" > 1 AND NOT EXISTS (SELECT 1 FROM "places" AS "parent_place" WHERE "parent_place"."id" = NEW."parent_id" AND "parent_place"."country_code" = NEW."country_code" AND "parent_place"."level" = NEW."level" - 1))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PLACE_PARENT_INVALID';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "places_parent_guard_insert"
BEFORE INSERT ON "places"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."places_parent_guard_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."places_parent_guard_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS NOT NULL AND (NEW."parent_id" IS DISTINCT FROM OLD."parent_id" OR NEW."level" IS DISTINCT FROM OLD."level" OR NEW."country_code" IS DISTINCT FROM OLD."country_code") AND ((NEW."level" = 1 AND NEW."parent_id" IS NOT NULL) OR (NEW."level" > 1 AND NOT EXISTS (SELECT 1 FROM "places" AS "parent_place" WHERE "parent_place"."id" = NEW."parent_id" AND "parent_place"."country_code" = NEW."country_code" AND "parent_place"."level" = NEW."level" - 1)))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PLACE_PARENT_INVALID';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "places_parent_guard_update"
BEFORE UPDATE OF "parent_id", "level", "country_code" ON "places"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."places_parent_guard_update_fn"();
--> statement-breakpoint
-- A checkout priced with a place reviews again when the place changes for
-- buyers (import bookkeeping and courier ids alone fence nothing).
CREATE OR REPLACE FUNCTION scalius_compat."places_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "places_checkout_authority_insert"
AFTER INSERT ON "places"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."places_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."places_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."name" IS DISTINCT FROM OLD."name" OR NEW."parent_id" IS DISTINCT FROM OLD."parent_id" OR NEW."level" IS DISTINCT FROM OLD."level" OR NEW."country_code" IS DISTINCT FROM OLD."country_code" OR NEW."is_active" IS DISTINCT FROM OLD."is_active" OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "places_checkout_authority_update"
AFTER UPDATE ON "places"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."places_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."places_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "places_checkout_authority_delete"
AFTER DELETE ON "places"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."places_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_places_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['loc', 't:places']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_places_ins"
AFTER INSERT ON "places"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_places_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_places_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['loc', 't:places']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_places_del"
AFTER DELETE ON "places"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_places_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_places_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['loc', 't:places']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_places_upd"
AFTER UPDATE ON "places"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."level" IS DISTINCT FROM NEW."level" OR OLD."parent_id" IS DISTINCT FROM NEW."parent_id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."external_ids" IS DISTINCT FROM NEW."external_ids" OR OLD."metadata" IS DISTINCT FROM NEW."metadata" OR OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."sort_order" IS DISTINCT FROM NEW."sort_order" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"))
EXECUTE FUNCTION scalius_compat."cdep_places_upd_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (118, '0118_places', 'dc815805ef4e280f62f3ea15e0dd81b7e001cf246bdc34244cfd8a9f2f8286d1');
