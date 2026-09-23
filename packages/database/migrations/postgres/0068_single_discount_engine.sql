ALTER TABLE "promotions" ADD COLUMN "combines_with_product_discounts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "combines_with_order_discounts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "combines_with_shipping_discounts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "promotions" SET "status" = 'archived', "deleted_at" = cast(extract(epoch from now()) as bigint), "updated_at" = cast(extract(epoch from now()) as bigint)
WHERE "deleted_at" IS NULL AND "id" IN (
  SELECT "promotion_id" FROM "promotion_effects" WHERE "deleted_at" IS NULL
  GROUP BY "promotion_id" HAVING count(*) > 1
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."promotion_redemptions_allocation_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
    SELECT 1 FROM order_discount_allocations
    WHERE order_id = NEW.order_id AND promotion_id = NEW.promotion_id
  )
  OR EXISTS (
    SELECT 1 FROM order_discount_allocations
    WHERE order_id = NEW.order_id
      AND promotion_id = NEW.promotion_id
      AND (
        promotion_revision <> NEW.promotion_revision
        OR method <> 'code'
        OR promotion_code <> NEW.promotion_code
        OR currency_code <> NEW.currency_code
      )
  )
  OR (
    SELECT coalesce(sum(discount_amount_minor), 0)
    FROM order_discount_allocations
    WHERE order_id = NEW.order_id AND promotion_id = NEW.promotion_id
  ) <> NEW.discount_amount_minor), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PROMOTION_REDEMPTION_ALLOCATION_MISMATCH';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "promotion_codes_legacy_identity_insert_guard" ON "promotion_codes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "promotion_codes_legacy_identity_update_guard" ON "promotion_codes";
--> statement-breakpoint
DROP TABLE "discount_customer_redemptions";
--> statement-breakpoint
DROP TABLE "discount_usage";
--> statement-breakpoint
DROP TABLE "discount_collections";
--> statement-breakpoint
DROP TABLE "discount_products";
--> statement-breakpoint
DROP TABLE "discounts";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."promotion_codes_legacy_identity_insert_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."promotion_codes_legacy_identity_update_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discounts_promotion_identity_insert_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discounts_promotion_identity_update_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discount_usage_max_uses_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discount_usage_customer_identity_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discount_usage_one_per_customer_guard_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."discount_usage_customer_redemption_claim_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (68, '0068_single_discount_engine', '9c33e0354f8b670c98596fbfa9daa760198a6fed7287c309293a4661ff5d8ce3');
