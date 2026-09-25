-- Order-line fulfilment (Wave A §2, §5.2). Expand-only: the API that is live
-- while this migrates keeps working. Variants gain a fulfilment kind and
-- products a gift-card flag; orders gain requires_shipping, the delivery
-- method kind and pickup snapshots, and their address becomes nullable
-- (required by trigger only when something ships). Order lines gain a frozen
-- fulfilment type and fulfilled_quantity, the projection of a new append-only
-- fulfilment ledger. Every historical line is `ship`, and every shipped unit
-- is backfilled into the ledger before its projection triggers exist.
ALTER TABLE "product_variants" ADD COLUMN "fulfillment_kind" text DEFAULT 'physical' NOT NULL CONSTRAINT "product_variants_fulfillment_kind_check" CHECK ("fulfillment_kind" IN ('physical', 'digital', 'service'));
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_variants_checkout_authority_update" ON "product_variants";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_variants_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."product_id" IS DISTINCT FROM OLD."product_id"
  OR NEW."option_combination_key" IS DISTINCT FROM OLD."option_combination_key"
  OR NEW."image_id" IS DISTINCT FROM OLD."image_id"
  OR NEW."price_minor" IS DISTINCT FROM OLD."price_minor"
  OR NEW."is_default" IS DISTINCT FROM OLD."is_default"
  OR NEW."track_inventory" IS DISTINCT FROM OLD."track_inventory"
  OR NEW."allow_preorder" IS DISTINCT FROM OLD."allow_preorder"
  OR NEW."allow_backorder" IS DISTINCT FROM OLD."allow_backorder"
  OR NEW."backorder_limit" IS DISTINCT FROM OLD."backorder_limit"
  OR NEW."tax_class_id" IS DISTINCT FROM OLD."tax_class_id"
  OR NEW."tax_classification_version" IS DISTINCT FROM OLD."tax_classification_version"
  OR NEW."discount_bps" IS DISTINCT FROM OLD."discount_bps"
  OR NEW."discount_type" IS DISTINCT FROM OLD."discount_type"
  OR NEW."discount_amount_minor" IS DISTINCT FROM OLD."discount_amount_minor"
  OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
  OR NEW."fulfillment_kind" IS DISTINCT FROM OLD."fulfillment_kind"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_variants_checkout_authority_update"
AFTER UPDATE ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_variants_checkout_authority_update_fn"();
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_gift_card" bigint DEFAULT 0 NOT NULL CONSTRAINT "products_is_gift_card_check" CHECK ("is_gift_card" IN (0, 1));
--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_checkout_authority_update" ON "products";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."name" IS DISTINCT FROM OLD."name"
  OR NEW."price_minor" IS DISTINCT FROM OLD."price_minor"
  OR NEW."category_id" IS DISTINCT FROM OLD."category_id"
  OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
  OR NEW."is_active" IS DISTINCT FROM OLD."is_active"
  OR NEW."discount_bps" IS DISTINCT FROM OLD."discount_bps"
  OR NEW."discount_type" IS DISTINCT FROM OLD."discount_type"
  OR NEW."discount_amount_minor" IS DISTINCT FROM OLD."discount_amount_minor"
  OR NEW."free_delivery" IS DISTINCT FROM OLD."free_delivery"
  OR NEW."tax_class_id" IS DISTINCT FROM OLD."tax_class_id"
  OR NEW."tax_classification_version" IS DISTINCT FROM OLD."tax_classification_version"
  OR NEW."is_gift_card" IS DISTINCT FROM OLD."is_gift_card"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "products_checkout_authority_update"
AFTER UPDATE ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_checkout_authority_update_fn"();
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "requires_shipping" bigint DEFAULT 1 NOT NULL CONSTRAINT "orders_requires_shipping_check" CHECK ("requires_shipping" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_method_kind" text CONSTRAINT "orders_shipping_method_kind_check" CHECK ("shipping_method_kind" IS NULL OR "shipping_method_kind" IN ('delivery', 'pickup'));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_address" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_hours" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_ready_at" bigint;
--> statement-breakpoint
-- The address becomes nullable in place (SQLite needs rename/add/copy/drop).
ALTER TABLE "orders"
  ALTER COLUMN "shipping_address" DROP NOT NULL,
  ALTER COLUMN "city" DROP NOT NULL,
  ALTER COLUMN "zone" DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."orders_shipping_address_required_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."requires_shipping" = 1
  AND (NEW."shipping_address" IS NULL OR trim(NEW."shipping_address") = '' OR NEW."city" IS NULL OR NEW."zone" IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'shipping address required';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "orders_shipping_address_required_insert"
BEFORE INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."orders_shipping_address_required_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."orders_shipping_address_required_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."requires_shipping" = 1
  AND (NEW."shipping_address" IS NULL OR trim(NEW."shipping_address") = '' OR NEW."city" IS NULL OR NEW."zone" IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'shipping address required';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "orders_shipping_address_required_update"
BEFORE UPDATE OF "requires_shipping", "shipping_address", "city", "zone" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."orders_shipping_address_required_update_fn"();
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfillment_type" text DEFAULT 'ship' NOT NULL CONSTRAINT "order_items_fulfillment_type_check" CHECK ("fulfillment_type" IN ('ship', 'pickup', 'digital', 'gift_card', 'service'));
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfilled_quantity" bigint DEFAULT 0 NOT NULL CONSTRAINT "order_items_fulfilled_quantity_bounds" CHECK ("fulfilled_quantity" >= 0 AND "fulfilled_quantity" <= "quantity");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_items_fulfillment_type_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."fulfillment_type" IS DISTINCT FROM OLD."fulfillment_type"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order line fulfilment type is immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_items_fulfillment_type_immutable"
BEFORE UPDATE OF "fulfillment_type" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_items_fulfillment_type_immutable_fn"();
--> statement-breakpoint
CREATE TABLE "order_fulfillments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"shipment_id" text,
	"request_key" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"cash_collected_minor" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"voided_at" bigint,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("shipment_id") REFERENCES "delivery_shipments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_fulfillments_kind_check" CHECK("order_fulfillments"."kind" IN ('ship', 'pickup', 'digital', 'gift_card', 'service')),
	CONSTRAINT "order_fulfillments_status_check" CHECK("order_fulfillments"."status" IN ('active', 'voided')),
	CONSTRAINT "order_fulfillments_void_shape" CHECK(("order_fulfillments"."status" = 'active' AND "order_fulfillments"."voided_at" IS NULL) OR ("order_fulfillments"."status" = 'voided' AND "order_fulfillments"."voided_at" IS NOT NULL)),
	CONSTRAINT "order_fulfillments_actor_type_check" CHECK("order_fulfillments"."actor_type" IN ('admin', 'system')),
	CONSTRAINT "order_fulfillments_request_key_length" CHECK(length(trim("order_fulfillments"."request_key")) BETWEEN 1 AND 200),
	CONSTRAINT "order_fulfillments_cash_nonnegative" CHECK("order_fulfillments"."cash_collected_minor" IS NULL OR "order_fulfillments"."cash_collected_minor" >= 0),
	CONSTRAINT "order_fulfillments_shipment_is_ship" CHECK("order_fulfillments"."shipment_id" IS NULL OR "order_fulfillments"."kind" = 'ship')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_fulfillments_order_request_key_unique" ON "order_fulfillments" ("order_id","request_key");
--> statement-breakpoint
CREATE INDEX "order_fulfillments_order_created_idx" ON "order_fulfillments" ("order_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "order_fulfillments_shipment_unique" ON "order_fulfillments" ("shipment_id") WHERE "order_fulfillments"."shipment_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "order_fulfillment_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfillment_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"quantity" bigint NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("fulfillment_id") REFERENCES "order_fulfillments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_fulfillment_lines_quantity_positive" CHECK("order_fulfillment_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_fulfillment_lines_fulfillment_item_unique" ON "order_fulfillment_lines" ("fulfillment_id","order_item_id");
--> statement-breakpoint
CREATE INDEX "order_fulfillment_lines_order_item_idx" ON "order_fulfillment_lines" ("order_item_id");
--> statement-breakpoint
CREATE INDEX "order_fulfillment_lines_order_idx" ON "order_fulfillment_lines" ("order_id");
--> statement-breakpoint
-- Backfill: one system `ship` fulfilment per order that has sent units, with
-- one line per sent order line, then the projection. The ledger triggers are
-- created after this so the backfill is not projected twice.
INSERT INTO "order_fulfillments" ("id", "order_id", "kind", "status", "request_key", "actor_type", "created_at")
SELECT 'ful_mig_' || o."id", o."id", 'ship', 'active', 'migration:0083', 'system', o."updated_at"
FROM "orders" AS o
WHERE EXISTS (
  SELECT 1 FROM "order_items" AS oi
  WHERE oi."order_id" = o."id" AND oi."shipped_quantity" > 0
);
--> statement-breakpoint
INSERT INTO "order_fulfillment_lines" ("id", "fulfillment_id", "order_id", "order_item_id", "quantity", "created_at")
SELECT 'fln_mig_' || oi."id", 'ful_mig_' || oi."order_id", oi."order_id", oi."id", min(oi."shipped_quantity", oi."quantity"), o."updated_at"
FROM "order_items" AS oi
JOIN "orders" AS o ON o."id" = oi."order_id"
WHERE oi."shipped_quantity" > 0;
--> statement-breakpoint
UPDATE "order_items" SET "fulfilled_quantity" = min("shipped_quantity", "quantity")
WHERE "shipped_quantity" > 0;
--> statement-breakpoint
-- F2: a line joins an active fulfilment of the same order and type, and never
-- takes the line past its quantity.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_match_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
  SELECT 1
  FROM "order_fulfillments" AS f
  JOIN "order_items" AS oi ON oi."id" = NEW."order_item_id"
  WHERE f."id" = NEW."fulfillment_id"
    AND f."order_id" = NEW."order_id"
    AND oi."order_id" = NEW."order_id"
    AND f."status" = 'active'
    AND oi."fulfillment_type" = f."kind"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilment line must match an active fulfilment of the same order and type';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_match_insert"
BEFORE INSERT ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_match_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_bounds_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
  SELECT 1 FROM "order_items" AS oi
  WHERE oi."id" = NEW."order_item_id"
    AND oi."fulfilled_quantity" + NEW."quantity" <= oi."quantity"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilment exceeds the unfulfilled line quantity';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_bounds_insert"
BEFORE INSERT ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_bounds_insert_fn"();
--> statement-breakpoint
-- F1: fulfilled_quantity is the sum of active ledger lines.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_project_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "order_items" SET "fulfilled_quantity" = "fulfilled_quantity" + NEW."quantity" WHERE "id" = NEW."order_item_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_project_insert"
AFTER INSERT ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_project_insert_fn"();
--> statement-breakpoint
-- F3: the ledger is append-only; a fulfilment only moves active -> voided.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_update_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilment lines are immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_update_blocked"
BEFORE UPDATE ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_update_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilment lines are immutable';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_delete_blocked"
BEFORE DELETE ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_delete_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillments_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT (
  OLD."status" = 'active'
  AND NEW."status" = 'voided'
  AND NEW."id" IS NOT DISTINCT FROM OLD."id"
  AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
  AND NEW."kind" IS NOT DISTINCT FROM OLD."kind"
  AND NEW."shipment_id" IS NOT DISTINCT FROM OLD."shipment_id"
  AND NEW."request_key" IS NOT DISTINCT FROM OLD."request_key"
  AND NEW."actor_type" IS NOT DISTINCT FROM OLD."actor_type"
  AND NEW."actor_id" IS NOT DISTINCT FROM OLD."actor_id"
  AND NEW."cash_collected_minor" IS NOT DISTINCT FROM OLD."cash_collected_minor"
  AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilments are immutable except active to voided';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillments_update_guard"
BEFORE UPDATE ON "order_fulfillments"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillments_update_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillments_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fulfilments are durable order evidence';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillments_delete_blocked"
BEFORE DELETE ON "order_fulfillments"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillments_delete_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillments_project_void_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."status" = 'active' AND NEW."status" = 'voided'), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_items" SET "fulfilled_quantity" = "fulfilled_quantity" - (
    SELECT coalesce(sum(l."quantity"), 0) FROM "order_fulfillment_lines" AS l
    WHERE l."fulfillment_id" = NEW."id" AND l."order_item_id" = "order_items"."id"
  )
  WHERE "id" IN (SELECT "order_item_id" FROM "order_fulfillment_lines" WHERE "fulfillment_id" = NEW."id");
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillments_project_void"
AFTER UPDATE OF "status" ON "order_fulfillments"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillments_project_void_fn"();
--> statement-breakpoint
-- F12: returns come only from physically handed-over lines and are bounded by
-- what was handed over. Until the contract migration drops the legacy line
-- columns, a line the previous API marked shipped/delivered stays returnable
-- up to its quantity, exactly as before.
DROP TRIGGER IF EXISTS "order_return_lines_validate_insert" ON "order_return_lines";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_return_lines_validate_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
    SELECT 1
    FROM "order_items" oi
    JOIN "order_returns" r ON r.id = NEW.return_id
    WHERE oi.id = NEW.order_item_id
      AND oi.order_id = NEW.order_id
      AND r.order_id = NEW.order_id
      AND oi.fulfillment_type IN ('ship', 'pickup')
      AND (oi.fulfilled_quantity > 0 OR oi.fulfillment_status IN ('shipped', 'delivered'))
      AND (NEW.inventory_tracked = 0 OR (NEW.variant_id IS NOT NULL AND NEW.variant_id = oi.variant_id))
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'return line must reference a shipped item in the same order';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_return_lines_validate_insert"
BEFORE INSERT ON "order_return_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_return_lines_validate_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_return_lines_entitlement_insert" ON "order_return_lines";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_return_lines_entitlement_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((
    COALESCE((
        SELECT SUM(CASE
            WHEN r.status = 'requested' THEN rl.requested_quantity
            WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
            ELSE 0
        END)
        FROM "order_return_lines" rl
        JOIN "order_returns" r ON r.id = rl.return_id
        WHERE rl.order_item_id = NEW.order_item_id
    ), 0) + NEW.requested_quantity
) > (
    SELECT max(oi.fulfilled_quantity, CASE WHEN oi.fulfillment_status IN ('shipped', 'delivered') THEN oi.quantity ELSE 0 END)
    FROM "order_items" oi WHERE oi.id = NEW.order_item_id
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cumulative return quantity exceeds fulfilled item quantity';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_return_lines_entitlement_insert"
BEFORE INSERT ON "order_return_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_return_lines_entitlement_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_returns_entitlement_status_update" ON "order_returns";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_returns_entitlement_status_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (
    SELECT 1
    FROM "order_items" oi
    WHERE oi.order_id = NEW.order_id
      AND COALESCE((
          SELECT SUM(CASE
              WHEN r.id = NEW.id THEN CASE
                  WHEN NEW.status = 'requested' THEN rl.requested_quantity
                  WHEN NEW.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
                  ELSE 0
              END
              WHEN r.status = 'requested' THEN rl.requested_quantity
              WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
              ELSE 0
          END)
          FROM "order_return_lines" rl
          JOIN "order_returns" r ON r.id = rl.return_id
          WHERE rl.order_item_id = oi.id
      ), 0) > max(oi.fulfilled_quantity, CASE WHEN oi.fulfillment_status IN ('shipped', 'delivered') THEN oi.quantity ELSE 0 END)
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cumulative return quantity exceeds fulfilled item quantity';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_returns_entitlement_status_update"
BEFORE UPDATE OF "status" ON "order_returns"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_returns_entitlement_status_update_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (83, '0083_order_line_fulfilment', '03d720537b4e7efef98e38074a3c474b2caeaf6b8cdc71c3ca84a63ac5024d19');
