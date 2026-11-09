-- App coverage on native warranties, and lifetime warranties: see
-- ../0214_app_warranty_coverage.sql. PostgreSQL alters the columns and
-- constraints in place; the lifetime form matches SQLite's.
INSERT INTO "permissions" ("id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive")
SELECT 'perm_orders_manage_warranties', 'orders.manage_warranties', 'Manage Warranties', 'Issue and void warranty coverage on order lines', 'orders', 'manage_warranties', 'Orders', 0
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "name" = 'orders.manage_warranties');
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT 'rpm_warranties_' || "granted"."role_id", "granted"."role_id", "manage"."id"
FROM "role_permissions" AS "granted"
JOIN "permissions" AS "edit" ON "edit"."id" = "granted"."permission_id" AND "edit"."name" = 'orders.edit'
JOIN "permissions" AS "manage" ON "manage"."name" = 'orders.manage_warranties'
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" AS "existing"
  WHERE "existing"."role_id" = "granted"."role_id" AND "existing"."permission_id" = "manage"."id"
);
--> statement-breakpoint
INSERT INTO "user_permissions" ("id", "user_id", "permission_id", "granted", "assigned_by")
SELECT 'upm_warranties_' || "direct"."user_id", "direct"."user_id", "manage"."id", "direct"."granted", "direct"."assigned_by"
FROM "user_permissions" AS "direct"
JOIN "permissions" AS "edit" ON "edit"."id" = "direct"."permission_id" AND "edit"."name" = 'orders.edit'
JOIN "permissions" AS "manage" ON "manage"."name" = 'orders.manage_warranties'
WHERE NOT EXISTS (
  SELECT 1 FROM "user_permissions" AS "existing"
  WHERE "existing"."user_id" = "direct"."user_id" AND "existing"."permission_id" = "manage"."id"
);
--> statement-breakpoint
UPDATE agent_grants
SET permissions_json = substr(rtrim(permissions_json), 1, length(rtrim(permissions_json)) - 1) || ',"orders.manage_warranties"]'
WHERE position('"orders.edit"' in permissions_json) > 0 AND position('"orders.manage_warranties"' in permissions_json) = 0;
--> statement-breakpoint
UPDATE agent_device_authorizations
SET requested_permissions_json = substr(rtrim(requested_permissions_json), 1, length(rtrim(requested_permissions_json)) - 1) || ',"orders.manage_warranties"]'
WHERE position('"orders.edit"' in requested_permissions_json) > 0 AND position('"orders.manage_warranties"' in requested_permissions_json) = 0;
--> statement-breakpoint
ALTER TABLE "warranty_policies" ADD COLUMN "lifetime" bigint DEFAULT 0 NOT NULL
  CONSTRAINT "warranty_policies_lifetime_check" CHECK ("lifetime" = 0 OR ("lifetime" = 1 AND "duration_value" = 120 AND "duration_unit" = 'years'));
--> statement-breakpoint
ALTER TABLE "warranty_policies" ADD COLUMN "app_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "warranty_policies" ADD COLUMN "app_key" text COLLATE "C"
  CONSTRAINT "warranty_policies_app_shape" CHECK (("app_id" IS NULL) = ("app_key" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_policies_app_key_unique" ON "warranty_policies" ("app_id","app_key") WHERE "warranty_policies"."app_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "warranty_policy_revisions" ADD COLUMN "lifetime" bigint DEFAULT 0 NOT NULL
  CONSTRAINT "warranty_policy_revisions_lifetime_check" CHECK ("lifetime" = 0 OR ("lifetime" = 1 AND "duration_value" = 120 AND "duration_unit" = 'years'));
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ALTER COLUMN "fulfillment_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ALTER COLUMN "fulfillment_line_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ADD COLUMN "app_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ADD COLUMN "unit_number" bigint;
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ADD COLUMN "code" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "order_item_warranties" DROP CONSTRAINT "order_item_warranties_window";
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ADD CONSTRAINT "order_item_warranties_window" CHECK("order_item_warranties"."expires_at" IS NULL OR "order_item_warranties"."expires_at" > "order_item_warranties"."starts_at");
--> statement-breakpoint
ALTER TABLE "order_item_warranties" ADD CONSTRAINT "order_item_warranties_source_shape" CHECK(("order_item_warranties"."app_id" IS NULL AND "order_item_warranties"."fulfillment_id" IS NOT NULL AND "order_item_warranties"."fulfillment_line_id" IS NOT NULL AND "order_item_warranties"."unit_number" IS NULL AND "order_item_warranties"."code" IS NULL)
            OR ("order_item_warranties"."app_id" IS NOT NULL AND "order_item_warranties"."fulfillment_id" IS NULL AND "order_item_warranties"."fulfillment_line_id" IS NULL AND "order_item_warranties"."unit_number" >= 1 AND "order_item_warranties"."quantity" = 1 AND length("order_item_warranties"."code") = 11));
--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_warranties_app_unit_unique" ON "order_item_warranties" ("order_item_id","app_id","unit_number") WHERE "order_item_warranties"."app_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_warranties_code_unique" ON "order_item_warranties" ("code") WHERE "order_item_warranties"."code" IS NOT NULL;
--> statement-breakpoint
-- W1 for a period: the record ends by the revision's duration.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_warranty_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT r."lifetime" FROM "order_items" AS i JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id" WHERE i."id" = NEW."order_item_id") = 0), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "order_item_warranties" ("id", "order_id", "order_item_id", "fulfillment_id", "fulfillment_line_id", "revision_id", "quantity", "starts_at", "expires_at", "replacement_until")
  SELECT 'wty_' || NEW."id", NEW."order_id", NEW."order_item_id", NEW."fulfillment_id", NEW."id", r."id", NEW."quantity", f."created_at",
    unixepoch(f."created_at", 'unixepoch', '+' || r."duration_value" || ' ' || r."duration_unit"),
    f."created_at" + r."replacement_days" * 86400
  FROM "order_items" AS i
  JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id"
  JOIN "order_fulfillments" AS f ON f."id" = NEW."fulfillment_id"
  WHERE i."id" = NEW."order_item_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
-- W1 for a lifetime revision: the record has no end.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_lifetime_warranty_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT r."lifetime" FROM "order_items" AS i JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id" WHERE i."id" = NEW."order_item_id") = 1), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "order_item_warranties" ("id", "order_id", "order_item_id", "fulfillment_id", "fulfillment_line_id", "revision_id", "quantity", "starts_at", "expires_at", "replacement_until")
  SELECT 'wty_' || NEW."id", NEW."order_id", NEW."order_item_id", NEW."fulfillment_id", NEW."id", r."id", NEW."quantity", f."created_at", NULL,
    f."created_at" + r."replacement_days" * 86400
  FROM "order_items" AS i
  JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id"
  JOIN "order_fulfillments" AS f ON f."id" = NEW."fulfillment_id"
  WHERE i."id" = NEW."order_item_id";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_fulfillment_lines_lifetime_warranty_insert"
AFTER INSERT ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_lifetime_warranty_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_warranty_policies_upd" ON "warranty_policies";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_warranty_policies_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:warranty_policies']::text[]) AS key_list(value) UNION SELECT 'p:' || key_ref_0.ref FROM (SELECT warranty_product.id AS ref FROM products AS warranty_product WHERE warranty_product.warranty_policy_id = NEW.id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_warranty_policies_upd"
AFTER UPDATE ON "warranty_policies"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."provider" IS DISTINCT FROM NEW."provider" OR OLD."duration_value" IS DISTINCT FROM NEW."duration_value" OR OLD."duration_unit" IS DISTINCT FROM NEW."duration_unit" OR OLD."replacement_days" IS DISTINCT FROM NEW."replacement_days" OR OLD."terms" IS DISTINCT FROM NEW."terms" OR OLD."archived_at" IS DISTINCT FROM NEW."archived_at" OR OLD."lifetime" IS DISTINCT FROM NEW."lifetime"))
EXECUTE FUNCTION scalius_compat."cdep_warranty_policies_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_warranty_policies_sku_upd" ON "warranty_policies";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_warranty_policies_sku_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:warranty_policies']::text[]) AS key_list(value) UNION SELECT 'p:' || key_ref_0.ref FROM (SELECT warranty_sku.product_id AS ref FROM product_variants AS warranty_sku WHERE warranty_sku.warranty_policy_id = NEW.id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_warranty_policies_sku_upd"
AFTER UPDATE ON "warranty_policies"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."provider" IS DISTINCT FROM NEW."provider" OR OLD."duration_value" IS DISTINCT FROM NEW."duration_value" OR OLD."duration_unit" IS DISTINCT FROM NEW."duration_unit" OR OLD."replacement_days" IS DISTINCT FROM NEW."replacement_days" OR OLD."terms" IS DISTINCT FROM NEW."terms" OR OLD."archived_at" IS DISTINCT FROM NEW."archived_at" OR OLD."lifetime" IS DISTINCT FROM NEW."lifetime"))
EXECUTE FUNCTION scalius_compat."cdep_warranty_policies_sku_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_item_warranties_issued_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'warranty.*', 'warranty.issued')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'warranty.issued', 'warranty', NEW."id", jsonb_build_object('warrantyId', NEW."id", 'orderId', NEW."order_id", 'orderItemId', NEW."order_item_id", 'appId', NEW."app_id", 'quantity', NEW."quantity")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_item_warranties_issued"
AFTER INSERT ON "order_item_warranties"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_order_item_warranties_issued_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_item_warranties_voided_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'warranty.*', 'warranty.voided')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'warranty.voided', 'warranty', NEW."id", jsonb_build_object('warrantyId', NEW."id", 'orderId', NEW."order_id", 'orderItemId', NEW."order_item_id", 'appId', NEW."app_id", 'quantity', NEW."quantity")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_item_warranties_voided"
AFTER UPDATE ON "order_item_warranties"
FOR EACH ROW
WHEN ((OLD."voided_at" IS NULL AND NEW."voided_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_order_item_warranties_voided_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (214, '0214_app_warranty_coverage', '17bad81d58f6a8210bd7e84bf714888f8d6aab82be443e29b1d9ba4adac32b65');
