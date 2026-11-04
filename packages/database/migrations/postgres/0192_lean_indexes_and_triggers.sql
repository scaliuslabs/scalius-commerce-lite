-- Index diet, read indexes and dead order cache triggers: see ../0192_lean_indexes_and_triggers.sql.
DROP TRIGGER IF EXISTS "cdep_orders_ins" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_orders_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_orders_del" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_orders_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_orders_upd" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_orders_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_orders_upd_old" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_orders_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_order_items_ins" ON "order_items";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_order_items_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_order_items_del" ON "order_items";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_order_items_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_order_items_upd" ON "order_items";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_order_items_upd_fn"();
--> statement-breakpoint
DROP INDEX IF EXISTS "inventory_movements_order_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "inventory_movements_variant_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "refund_attempts_order_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "refund_attempts_source_payment_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "notification_delivery_receipts_outbox_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "media_upload_parts_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "product_attributes_slug_idx";
--> statement-breakpoint
CREATE INDEX "media_pending_variants_idx" ON "media" ("kind","status","created_at","id") WHERE "media"."variant_width" IS NULL;
--> statement-breakpoint
CREATE INDEX "customers_email_norm_idx" ON "customers" (lower(trim("email")));
--> statement-breakpoint
CREATE INDEX "products_name_identity_idx" ON "products" (lower(trim("name")));
--> statement-breakpoint
CREATE INDEX "customers_deleted_verified_email_idx" ON "customers" (lower("email")) WHERE "customers"."deleted_at" IS NOT NULL AND "customers"."email_verified_at" IS NOT NULL AND "customers"."account_claimed_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "abandoned_checkouts_updated_idx" ON "abandoned_checkouts" ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "meta_conversions_logs_created_idx" ON "meta_conversions_logs" ("created_at","id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (192, '0192_lean_indexes_and_triggers', '3232b15951c34cd992c88ec330a1d3332b4055540a0786814bbba6916e891c3f');
