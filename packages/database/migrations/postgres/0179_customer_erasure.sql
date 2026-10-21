ALTER TABLE "customers" ADD COLUMN "erased_at" bigint;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "sku" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "circuit_failures" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "circuit_window_at" bigint;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "circuit_open_until" bigint;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_items_unit_cost_snapshot" ON "order_items";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."order_items_unit_cost_snapshot_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_items_line_snapshot_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."variant_id" IS NOT NULL AND (NEW."unit_cost_minor" IS NULL OR NEW."sku" IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_items" SET "unit_cost_minor" = coalesce(NEW."unit_cost_minor", (SELECT "cost_minor" FROM "product_variants" WHERE "id" = NEW."variant_id")), "sku" = coalesce(NEW."sku", (SELECT "sku" FROM "product_variants" WHERE "id" = NEW."variant_id")) WHERE "id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_items_line_snapshot"
AFTER INSERT ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_items_line_snapshot_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."conversation_messages_update_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT (
  OLD."kind" = 'message' AND OLD."author_type" IN ('customer', 'guest_receipt')
  AND NEW."body" IS NOT DISTINCT FROM '[erased]'
  AND NEW."id" IS NOT DISTINCT FROM OLD."id" AND NEW."conversation_id" IS NOT DISTINCT FROM OLD."conversation_id" AND NEW."seq" IS NOT DISTINCT FROM OLD."seq"
  AND NEW."kind" IS NOT DISTINCT FROM OLD."kind" AND NEW."visibility" IS NOT DISTINCT FROM OLD."visibility" AND NEW."author_type" IS NOT DISTINCT FROM OLD."author_type"
  AND NEW."author_customer_id" IS NOT DISTINCT FROM OLD."author_customer_id" AND NEW."author_user_id" IS NOT DISTINCT FROM OLD."author_user_id"
  AND NEW."event_kind" IS NOT DISTINCT FROM OLD."event_kind" AND NEW."event_data" IS NOT DISTINCT FROM OLD."event_data"
  AND NEW."client_message_key" IS NOT DISTINCT FROM OLD."client_message_key" AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'conversation messages are append-only';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customers_updated" ON "customers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_addresses_deleted" ON "customer_addresses";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_updated"
AFTER UPDATE ON "customers"
FOR EACH ROW
WHEN ((NEW."erased_at" IS NULL AND (OLD."name" IS DISTINCT FROM NEW."name" OR OLD."email" IS DISTINCT FROM NEW."email" OR OLD."phone" IS DISTINCT FROM NEW."phone" OR OLD."account_claimed_at" IS DISTINCT FROM NEW."account_claimed_at" OR OLD."phone_verified_at" IS DISTINCT FROM NEW."phone_verified_at" OR OLD."email_verified_at" IS DISTINCT FROM NEW."email_verified_at" OR OLD."origin" IS DISTINCT FROM NEW."origin" OR OLD."merged_into_customer_id" IS DISTINCT FROM NEW."merged_into_customer_id" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at")))
EXECUTE FUNCTION scalius_compat."evt_customers_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_erased_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.erased')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.erased', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_erased"
AFTER UPDATE ON "customers"
FOR EACH ROW
WHEN ((OLD."erased_at" IS NULL AND NEW."erased_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_customers_erased_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_addresses_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((((SELECT "id" FROM "customers" WHERE "id" = OLD."customer_id") IS NOT NULL AND (SELECT "erased_at" FROM "customers" WHERE "id" = OLD."customer_id") IS NULL)), false) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', OLD."customer_id", jsonb_build_object('customerId', OLD."customer_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_addresses_deleted"
AFTER DELETE ON "customer_addresses"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customer_addresses_deleted_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (179, '0179_customer_erasure', 'ebc0400f10a2ec89a52a5622fae0e47520c4c7e7ed90b80e50e9f8ab8863ed38');
