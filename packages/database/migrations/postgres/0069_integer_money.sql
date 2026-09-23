-- Integer money (PostgreSQL sidecar of 0069_integer_money): every stored
-- amount becomes one NOT NULL bigint of minor units. Order-scoped amounts use
-- the order's own decimals; catalog and shipping amounts use the store currency.
CREATE TABLE "_integer_money_store" ("code" text NOT NULL, "places" bigint NOT NULL);
--> statement-breakpoint
INSERT INTO "_integer_money_store" ("code", "places")
SELECT store.code,
  CASE
    WHEN store.code IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
    WHEN store.code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
    ELSE 2
  END
FROM (
  SELECT coalesce(nullif(upper(trim((
    SELECT "value"::jsonb ->> 'currencyCode' FROM "settings"
    WHERE "category" = 'currency' AND "key" = 'document' AND json_valid("value")
    LIMIT 1
  ))), ''), 'BDT') AS code
) AS store;
--> statement-breakpoint
-- orders
UPDATE "orders" SET
  "currency_code" = coalesce("currency_code", (SELECT "code" FROM "_integer_money_store")),
  "currency_decimal_places" = coalesce("currency_decimal_places", (SELECT "places" FROM "_integer_money_store"));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "balance_due_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "orders" SET
  "subtotal_amount_minor" = coalesce("subtotal_amount_minor", (
    SELECT round((sum(item."price" * item."quantity") * (CASE "orders"."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint
    FROM "order_items" AS item WHERE item."order_id" = "orders"."id"
  ), 0),
  "shipping_amount_minor" = coalesce("shipping_amount_minor", round(("shipping_charge" * (CASE "currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint),
  "discount_amount_minor" = coalesce("discount_amount_minor", round((coalesce("discount_amount", 0) * (CASE "currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint),
  "total_amount_minor" = coalesce("total_amount_minor", round(("total_amount" * (CASE "currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint),
  "paid_amount_minor" = round(("paid_amount" * (CASE "currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint,
  "balance_due_minor" = round(("balance_due" * (CASE "currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "orders"
  ALTER COLUMN "currency_code" SET DEFAULT 'BDT',
  ALTER COLUMN "currency_code" SET NOT NULL,
  ALTER COLUMN "currency_decimal_places" SET DEFAULT 2,
  ALTER COLUMN "currency_decimal_places" SET NOT NULL,
  ALTER COLUMN "subtotal_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "subtotal_amount_minor" SET NOT NULL,
  ALTER COLUMN "shipping_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "shipping_amount_minor" SET NOT NULL,
  ALTER COLUMN "discount_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "discount_amount_minor" SET NOT NULL,
  ALTER COLUMN "total_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "total_amount_minor" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders"
  DROP COLUMN "total_amount",
  DROP COLUMN "shipping_charge",
  DROP COLUMN "discount_amount",
  DROP COLUMN "paid_amount",
  DROP COLUMN "balance_due";
--> statement-breakpoint
-- order_items
UPDATE "order_items" SET "unit_price_minor" = coalesce("unit_price_minor", round(("price" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "order_items"."order_id"
))::numeric)::bigint, 0);
--> statement-breakpoint
UPDATE "order_items" SET
  "line_subtotal_minor" = coalesce("line_subtotal_minor", "unit_price_minor" * "quantity"),
  "discount_amount_minor" = coalesce("discount_amount_minor", 0),
  "taxable_amount_minor" = coalesce("taxable_amount_minor", greatest(0, coalesce("line_subtotal_minor", "unit_price_minor" * "quantity") - coalesce("discount_amount_minor", 0)));
--> statement-breakpoint
ALTER TABLE "order_items"
  ALTER COLUMN "unit_price_minor" SET DEFAULT 0,
  ALTER COLUMN "unit_price_minor" SET NOT NULL,
  ALTER COLUMN "line_subtotal_minor" SET DEFAULT 0,
  ALTER COLUMN "line_subtotal_minor" SET NOT NULL,
  ALTER COLUMN "discount_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "discount_amount_minor" SET NOT NULL,
  ALTER COLUMN "taxable_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "taxable_amount_minor" SET NOT NULL,
  DROP COLUMN "price";
--> statement-breakpoint
-- order-scoped amounts converted with the parent order's decimals
ALTER TABLE "checkout_attempts" ADD COLUMN "total_amount_minor" bigint;
--> statement-breakpoint
UPDATE "checkout_attempts" SET "total_amount_minor" = round(("total_amount" * coalesce((
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "checkout_attempts"."order_id"
), 100))::numeric)::bigint WHERE "total_amount" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "checkout_attempts" DROP COLUMN "total_amount";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD COLUMN "amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "order_payments" SET "amount_minor" = round(("amount" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "order_payments"."order_id"
))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN "amount";
--> statement-breakpoint
ALTER TABLE "payment_session_attempts" ADD COLUMN "amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "payment_session_attempts" SET "amount_minor" = round(("amount" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "payment_session_attempts"."order_id"
))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "payment_session_attempts" DROP COLUMN "amount";
--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "refund_attempts" SET "amount_minor" = round(("amount" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "refund_attempts"."order_id"
))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "refund_attempts" DROP COLUMN "amount";
--> statement-breakpoint
ALTER TABLE "payment_plans"
  ADD COLUMN "total_amount_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "deposit_amount_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "balance_due_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "payment_plans" SET
  "total_amount_minor" = round(("total_amount" * (SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "payment_plans"."order_id"))::numeric)::bigint,
  "deposit_amount_minor" = round(("deposit_amount" * (SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "payment_plans"."order_id"))::numeric)::bigint,
  "balance_due_minor" = round(("balance_due" * (SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "payment_plans"."order_id"))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "payment_plans"
  DROP COLUMN "total_amount",
  DROP COLUMN "deposit_amount",
  DROP COLUMN "balance_due";
--> statement-breakpoint
ALTER TABLE "cod_tracking" ADD COLUMN "collected_amount_minor" bigint;
--> statement-breakpoint
UPDATE "cod_tracking" SET "collected_amount_minor" = round(("collected_amount" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "cod_tracking"."order_id"
))::numeric)::bigint WHERE "collected_amount" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "cod_tracking" DROP COLUMN "collected_amount";
--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "shipment_amount_minor" bigint;
--> statement-breakpoint
UPDATE "delivery_shipments" SET "shipment_amount_minor" = round(("shipment_amount" * (
  SELECT CASE o."currency_decimal_places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "orders" AS o WHERE o."id" = "delivery_shipments"."order_id"
))::numeric)::bigint WHERE "shipment_amount" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "delivery_shipments" DROP COLUMN "shipment_amount";
--> statement-breakpoint
-- tax snapshots keep the rules; their amount copies duplicated orders/order_items
ALTER TABLE "order_tax_snapshots"
  DROP CONSTRAINT IF EXISTS "order_tax_snapshots_minor_amounts_nonnegative",
  DROP COLUMN "subtotal_minor",
  DROP COLUMN "shipping_minor",
  DROP COLUMN "discount_minor",
  DROP COLUMN "taxable_minor",
  DROP COLUMN "tax_minor",
  DROP COLUMN "total_minor";
--> statement-breakpoint
ALTER TABLE "order_item_tax_snapshots"
  DROP CONSTRAINT IF EXISTS "order_item_tax_snapshots_quantity_positive",
  DROP CONSTRAINT IF EXISTS "order_item_tax_snapshots_minor_amounts_nonnegative",
  DROP COLUMN "unit_price_minor",
  DROP COLUMN "quantity",
  DROP COLUMN "gross_amount_minor",
  DROP COLUMN "discount_minor",
  DROP COLUMN "taxable_amount_minor",
  DROP COLUMN "tax_minor";
--> statement-breakpoint
-- customers.total_spent duplicated SUM(orders.paid_amount_minor); readers derive it.
ALTER TABLE "customers" DROP COLUMN "total_spent";
--> statement-breakpoint
-- store-currency amounts
ALTER TABLE "shipping_methods" ADD COLUMN "fee_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "shipping_methods" SET "fee_minor" = round(("fee" * (
  SELECT CASE "places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "_integer_money_store"
))::numeric)::bigint;
--> statement-breakpoint
ALTER TABLE "shipping_methods" DROP COLUMN "fee";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_checkout_authority_update" ON "products";
--> statement-breakpoint
ALTER TABLE "products"
  ADD COLUMN "price_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "discount_bps" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "discount_amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "products" SET
  "price_minor" = round(("price" * (SELECT CASE "places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "_integer_money_store"))::numeric)::bigint,
  "discount_bps" = least(10000, greatest(0, round((coalesce("discount_percentage", 0) * 100)::numeric)::bigint)),
  "discount_amount_minor" = greatest(0, round((coalesce("discount_amount", 0) * (SELECT CASE "places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "_integer_money_store"))::numeric)::bigint);
--> statement-breakpoint
ALTER TABLE "products"
  DROP COLUMN "price",
  DROP COLUMN "discount_percentage",
  DROP COLUMN "discount_amount";
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
    OR NEW."tax_classification_version" IS DISTINCT FROM OLD."tax_classification_version"), false) THEN
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
DROP TRIGGER IF EXISTS "product_variants_checkout_authority_update" ON "product_variants";
--> statement-breakpoint
ALTER TABLE "product_variants"
  ADD COLUMN "price_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "discount_bps" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "discount_amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "product_variants" SET
  "price_minor" = round(("price" * (SELECT CASE "places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "_integer_money_store"))::numeric)::bigint,
  "discount_bps" = least(10000, greatest(0, round((coalesce("discount_percentage", 0) * 100)::numeric)::bigint)),
  "discount_amount_minor" = greatest(0, round((coalesce("discount_amount", 0) * (SELECT CASE "places" WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM "_integer_money_store"))::numeric)::bigint);
--> statement-breakpoint
ALTER TABLE "product_variants"
  DROP COLUMN "price",
  DROP COLUMN "discount_percentage",
  DROP COLUMN "discount_amount";
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
    OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"), false) THEN
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
DROP TABLE "_integer_money_store";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (69, '0069_integer_money', '852add8cc9569b0f85a12fefb59f2e0d863bca2fb4c248768de79f9d2b274737');
