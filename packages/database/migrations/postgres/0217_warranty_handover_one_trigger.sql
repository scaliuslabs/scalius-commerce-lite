-- The warranty handover is one trigger again: see
-- ../0217_warranty_handover_one_trigger.sql. The handover trigger keeps its
-- name and calls the function replaced below.
DROP TRIGGER IF EXISTS "order_fulfillment_lines_lifetime_warranty_insert" ON "order_fulfillment_lines";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."order_fulfillment_lines_lifetime_warranty_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_warranty_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT i."warranty_revision_id" FROM "order_items" AS i WHERE i."id" = NEW."order_item_id") IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "order_item_warranties" ("id", "order_id", "order_item_id", "fulfillment_id", "fulfillment_line_id", "revision_id", "quantity", "starts_at", "expires_at", "replacement_until")
  SELECT 'wty_' || NEW."id", NEW."order_id", NEW."order_item_id", NEW."fulfillment_id", NEW."id", r."id", NEW."quantity", f."created_at",
    (SELECT unixepoch(f."created_at", 'unixepoch', '+' || r."duration_value" || ' ' || r."duration_unit") WHERE r."lifetime" = 0),
    f."created_at" + r."replacement_days" * 86400
  FROM "order_items" AS i
  JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id"
  JOIN "order_fulfillments" AS f ON f."id" = NEW."fulfillment_id"
  WHERE i."id" = NEW."order_item_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (217, '0217_warranty_handover_one_trigger', '5f7c0bfdd64867c6c352b7438a0781f681cb37aa30684d7595355e0d5b73626b');
