CREATE TABLE "delivery_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_zone_locations" (
	"location_id" text PRIMARY KEY NOT NULL,
	"zone_id" text NOT NULL,
	FOREIGN KEY ("location_id") REFERENCES "delivery_locations"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("zone_id") REFERENCES "delivery_zones"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "delivery_zone_locations_zone_id_idx" ON "delivery_zone_locations" ("zone_id");
--> statement-breakpoint
ALTER TABLE "shipping_methods"
  ADD COLUMN "zone_id" text REFERENCES "delivery_zones"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN "free_over_minor" bigint,
  ADD COLUMN "pickup_address" text,
  ADD COLUMN "pickup_hours" text,
  ADD COLUMN "kind" text DEFAULT 'delivery' NOT NULL,
  ADD CONSTRAINT "shipping_methods_kind_check" CHECK ("kind" = 'delivery' OR ("kind" = 'pickup' AND "zone_id" IS NULL AND length(trim(coalesce("pickup_address", ''))) > 0));
--> statement-breakpoint
DROP INDEX IF EXISTS "shipping_methods_name_unique";
--> statement-breakpoint
CREATE INDEX "shipping_methods_zone_id_idx" ON "shipping_methods" ("zone_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_methods_zone_name_uidx" ON "shipping_methods" (coalesce("zone_id", ''),lower(trim("name"))) WHERE "shipping_methods"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zones_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zones_checkout_authority_insert"
AFTER INSERT ON "delivery_zones"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zones_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zones_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zones_checkout_authority_update"
AFTER UPDATE ON "delivery_zones"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zones_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zones_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zones_checkout_authority_delete"
AFTER DELETE ON "delivery_zones"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zones_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zone_locations_checkout_authority_insert"
AFTER INSERT ON "delivery_zone_locations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zone_locations_checkout_authority_update"
AFTER UPDATE ON "delivery_zone_locations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_zone_locations_checkout_authority_delete"
AFTER DELETE ON "delivery_zone_locations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."delivery_zone_locations_checkout_authority_delete_fn"();
--> statement-breakpoint
ALTER TABLE "checkout_languages" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (72, '0072_delivery_zones', 'd30f2fc33db16f5c02a5b8be890d9cad078975edf126d6fc6b14c2c33d77cafd');
