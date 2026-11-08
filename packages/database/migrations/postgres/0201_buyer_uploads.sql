-- Buyer uploads (COMMERCE-HOOKS H17): see ../0201_buyer_uploads.sql. A row is
-- bound for good to its app, its input and (a line input) its product; the
-- order commit attaches it to one order once.
CREATE TABLE "buyer_uploads" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"app_id" text COLLATE "C" NOT NULL,
	"field_key" text COLLATE "C" NOT NULL,
	"target" text COLLATE "C" NOT NULL,
	"product_id" text COLLATE "C",
	"r2_key" text COLLATE "C" NOT NULL,
	"media_type" text COLLATE "C" NOT NULL,
	"size_bytes" bigint NOT NULL,
	"filename" text COLLATE "C" NOT NULL,
	"sha256" text COLLATE "C" NOT NULL,
	"uploader_key" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C",
	"order_item_id" text COLLATE "C",
	"attached_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "buyer_uploads_id_shape" CHECK(substr("buyer_uploads"."id", 1, 4) = 'bup_' AND length("buyer_uploads"."id") = 28),
	CONSTRAINT "buyer_uploads_app_shape" CHECK(length("buyer_uploads"."app_id") BETWEEN 3 AND 100 AND substr("buyer_uploads"."field_key", 1, length("buyer_uploads"."app_id") + 1) = "buyer_uploads"."app_id" || '.' AND length("buyer_uploads"."field_key") <= 160),
	CONSTRAINT "buyer_uploads_target_check" CHECK("buyer_uploads"."target" IN ('line', 'attribute')),
	CONSTRAINT "buyer_uploads_target_product" CHECK(("buyer_uploads"."target" = 'line' AND "buyer_uploads"."product_id" IS NOT NULL) OR ("buyer_uploads"."target" = 'attribute' AND "buyer_uploads"."product_id" IS NULL)),
	CONSTRAINT "buyer_uploads_r2_key_private" CHECK("buyer_uploads"."r2_key" = 'private/buyer-uploads/' || "buyer_uploads"."id"),
	CONSTRAINT "buyer_uploads_media_type_check" CHECK("buyer_uploads"."media_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CONSTRAINT "buyer_uploads_size_bounds" CHECK("buyer_uploads"."size_bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "buyer_uploads_filename_length" CHECK(length("buyer_uploads"."filename") BETWEEN 1 AND 120),
	CONSTRAINT "buyer_uploads_sha256_shape" CHECK(length("buyer_uploads"."sha256") = 64),
	CONSTRAINT "buyer_uploads_uploader_key_shape" CHECK(length("buyer_uploads"."uploader_key") = 64),
	CONSTRAINT "buyer_uploads_attach_shape" CHECK(("buyer_uploads"."order_id" IS NULL AND "buyer_uploads"."order_item_id" IS NULL AND "buyer_uploads"."attached_at" IS NULL) OR ("buyer_uploads"."order_id" IS NOT NULL AND "buyer_uploads"."attached_at" IS NOT NULL AND ("buyer_uploads"."target" = 'line') = ("buyer_uploads"."order_item_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX "buyer_uploads_orphan_idx" ON "buyer_uploads" ("created_at") WHERE "buyer_uploads"."order_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "buyer_uploads_uploader_idx" ON "buyer_uploads" ("uploader_key","created_at") WHERE "buyer_uploads"."order_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "buyer_uploads_order_idx" ON "buyer_uploads" ("order_id","id") WHERE "buyer_uploads"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "buyer_uploads_retention_idx" ON "buyer_uploads" ("attached_at") WHERE "buyer_uploads"."attached_at" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."buyer_uploads_identity_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."id" IS DISTINCT FROM OLD."id"
  OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
  OR NEW."field_key" IS DISTINCT FROM OLD."field_key"
  OR NEW."target" IS DISTINCT FROM OLD."target"
  OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
  OR NEW."r2_key" IS DISTINCT FROM OLD."r2_key"
  OR NEW."media_type" IS DISTINCT FROM OLD."media_type"
  OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
  OR NEW."filename" IS DISTINCT FROM OLD."filename"
  OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
  OR NEW."uploader_key" IS DISTINCT FROM OLD."uploader_key"
  OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  OR (OLD."order_id" IS NOT NULL AND (
    NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."order_item_id" IS DISTINCT FROM OLD."order_item_id"
    OR NEW."attached_at" IS DISTINCT FROM OLD."attached_at"
  ))
  OR (OLD."order_id" IS NULL AND NEW."order_id" IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM "orders" AS o WHERE o."id" = NEW."order_id")
    OR (NEW."order_item_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "order_items" AS i WHERE i."id" = NEW."order_item_id" AND i."order_id" = NEW."order_id"
    ))
  ))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'buyer_upload_immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "buyer_uploads_identity_guard"
BEFORE UPDATE ON "buyer_uploads"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."buyer_uploads_identity_guard_fn"();
--> statement-breakpoint
-- Erasure's storage work deletes buyer uploads too: its delete_file tasks may
-- name `private/buyer-uploads/` keys.
ALTER TABLE "customer_erasure_tasks" DROP CONSTRAINT "customer_erasure_tasks_shape";
--> statement-breakpoint
ALTER TABLE "customer_erasure_tasks" ADD CONSTRAINT "customer_erasure_tasks_shape" CHECK(("customer_erasure_tasks"."kind" = 'delete_file' AND "customer_erasure_tasks"."provider_id" IS NULL AND (substr("customer_erasure_tasks"."ref", 1, 22) = 'private/conversations/' OR substr("customer_erasure_tasks"."ref", 1, 22) = 'private/buyer-uploads/')) OR ("customer_erasure_tasks"."kind" = 'detach_payment_method' AND "customer_erasure_tasks"."provider_id" IS NOT NULL AND length("customer_erasure_tasks"."ref") >= 1));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (201, '0201_buyer_uploads', '583194217250dc0a0bd89e912d439fbb00d851199a350771fd200dd99d97c230');
