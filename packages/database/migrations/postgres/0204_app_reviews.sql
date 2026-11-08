-- App reviews: see ../0204_app_reviews.sql. PostgreSQL changes the table in
-- place (no rebuild): the line columns become nullable, the app column and
-- the shape checks are added, the line trigger checks a named line only and
-- identity covers who wrote the review. The cache dependency triggers are
-- reinstalled as generated (unchanged: `app_id` is noise).
ALTER TABLE "product_reviews"
  ALTER COLUMN "order_id" DROP NOT NULL,
  ALTER COLUMN "order_item_id" DROP NOT NULL,
  ADD COLUMN "app_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "product_reviews"
  DROP CONSTRAINT IF EXISTS "product_reviews_author_type_check",
  ADD CONSTRAINT "product_reviews_author_type_check" CHECK("product_reviews"."author_type" IN ('customer', 'guest_receipt', 'app')),
  ADD CONSTRAINT "product_reviews_line_shape" CHECK(("product_reviews"."order_id" IS NULL) = ("product_reviews"."order_item_id" IS NULL) AND ("product_reviews"."order_item_id" IS NOT NULL OR "product_reviews"."author_type" = 'app')),
  ADD CONSTRAINT "product_reviews_app_shape" CHECK(("product_reviews"."author_type" = 'app') = ("product_reviews"."app_id" IS NOT NULL) AND ("product_reviews"."app_id" IS NULL OR length("product_reviews"."app_id") BETWEEN 1 AND 128));
--> statement-breakpoint
CREATE INDEX "product_reviews_updated_idx" ON "product_reviews" ("updated_at","id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_reviews_line_eligible_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."order_item_id" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "order_items" AS i
  JOIN "orders" AS o ON o."id" = i."order_id"
  WHERE i."id" = NEW."order_item_id"
    AND i."order_id" = NEW."order_id"
    AND i."product_id" = NEW."product_id"
    AND (NEW."variant_id" IS NULL OR i."variant_id" = NEW."variant_id")
    AND i."fulfilled_quantity" > 0
    AND i."fulfillment_type" IN ('ship', 'pickup', 'digital', 'service')
    AND o."status" IN ('delivered', 'completed')
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review requires a fulfilled line of a delivered order';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_reviews_identity_immutable" ON "product_reviews";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_reviews_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."product_id" IS DISTINCT FROM OLD."product_id"
  OR NEW."order_item_id" IS DISTINCT FROM OLD."order_item_id"
  OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
  OR NEW."reviewer_key" IS DISTINCT FROM OLD."reviewer_key"
  OR NEW."author_type" IS DISTINCT FROM OLD."author_type"
  OR NEW."app_id" IS DISTINCT FROM OLD."app_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review identity is immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_reviews_identity_immutable"
BEFORE UPDATE OF "product_id", "order_item_id", "order_id", "reviewer_key", "author_type", "app_id" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_reviews_identity_immutable_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_product_reviews_ins" ON "product_reviews";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_reviews_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_reviews']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_reviews_ins"
AFTER INSERT ON "product_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_reviews_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_product_reviews_del" ON "product_reviews";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_reviews_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_reviews']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_reviews_del"
AFTER DELETE ON "product_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_reviews_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_product_reviews_upd" ON "product_reviews";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_reviews_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_reviews']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_reviews_upd"
AFTER UPDATE ON "product_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."product_id" IS DISTINCT FROM NEW."product_id" OR OLD."variant_id" IS DISTINCT FROM NEW."variant_id" OR OLD."order_id" IS DISTINCT FROM NEW."order_id" OR OLD."order_item_id" IS DISTINCT FROM NEW."order_item_id" OR OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."author_type" IS DISTINCT FROM NEW."author_type" OR OLD."author_display_name" IS DISTINCT FROM NEW."author_display_name" OR OLD."variant_label" IS DISTINCT FROM NEW."variant_label" OR OLD."rating" IS DISTINCT FROM NEW."rating" OR OLD."title" IS DISTINCT FROM NEW."title" OR OLD."body" IS DISTINCT FROM NEW."body" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."published_at" IS DISTINCT FROM NEW."published_at" OR OLD."reply_body" IS DISTINCT FROM NEW."reply_body" OR OLD."replied_at" IS DISTINCT FROM NEW."replied_at" OR OLD."edited_at" IS DISTINCT FROM NEW."edited_at" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"))
EXECUTE FUNCTION scalius_compat."cdep_product_reviews_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_product_reviews_upd_old" ON "product_reviews";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_reviews_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_reviews']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_reviews_upd_old"
AFTER UPDATE ON "product_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id"))
EXECUTE FUNCTION scalius_compat."cdep_product_reviews_upd_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (204, '0204_app_reviews', '267fcf0cc2d31bede8bd918125fc3423e828f9d00b0d711117152e5a90fedb91');
