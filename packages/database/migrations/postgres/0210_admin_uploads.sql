-- Admin uploads (COMMERCE-HOOKS H17): see ../0210_admin_uploads.sql. Staff
-- give a file to one of an app's admin forms: target `admin`, bound to its
-- app and admin route, never attached to an order, typed `text/csv`.
ALTER TABLE "buyer_uploads" DROP CONSTRAINT "buyer_uploads_target_check";
--> statement-breakpoint
ALTER TABLE "buyer_uploads" ADD CONSTRAINT "buyer_uploads_target_check" CHECK("buyer_uploads"."target" IN ('line', 'attribute', 'admin'));
--> statement-breakpoint
ALTER TABLE "buyer_uploads" DROP CONSTRAINT "buyer_uploads_target_product";
--> statement-breakpoint
ALTER TABLE "buyer_uploads" ADD CONSTRAINT "buyer_uploads_target_product" CHECK(("buyer_uploads"."target" = 'line' AND "buyer_uploads"."product_id" IS NOT NULL) OR ("buyer_uploads"."target" IN ('attribute', 'admin') AND "buyer_uploads"."product_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "buyer_uploads" DROP CONSTRAINT "buyer_uploads_media_type_check";
--> statement-breakpoint
ALTER TABLE "buyer_uploads" ADD CONSTRAINT "buyer_uploads_media_type_check" CHECK("buyer_uploads"."media_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv'));
--> statement-breakpoint
ALTER TABLE "buyer_uploads" DROP CONSTRAINT "buyer_uploads_attach_shape";
--> statement-breakpoint
ALTER TABLE "buyer_uploads" ADD CONSTRAINT "buyer_uploads_attach_shape" CHECK(("buyer_uploads"."order_id" IS NULL AND "buyer_uploads"."order_item_id" IS NULL AND "buyer_uploads"."attached_at" IS NULL) OR ("buyer_uploads"."order_id" IS NOT NULL AND "buyer_uploads"."attached_at" IS NOT NULL AND "buyer_uploads"."target" <> 'admin' AND ("buyer_uploads"."target" = 'line') = ("buyer_uploads"."order_item_id" IS NOT NULL)));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (210, '0210_admin_uploads', 'c75cc8d70bde716f0ed3ff2ad77a2981c9b9df7403c4cc1e7799a2e7c657ba4f');
