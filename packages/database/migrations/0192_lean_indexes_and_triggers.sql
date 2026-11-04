-- Order cache triggers whose keys no request reads: only the background
-- recommendation refresh ranked `recommendation-signals`, outside any request
-- scope, and no public read touches orders or order_items (`t:orders`,
-- `t:order_items`). They wrote 12 dependency rows on a 3-line checkout.
-- The recommendation_order_products maintenance triggers stay (it is read).
DROP TRIGGER IF EXISTS `cdep_orders_ins`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_orders_del`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_orders_upd`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_orders_upd_old`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_order_items_ins`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_order_items_del`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_order_items_upd`;--> statement-breakpoint
-- Indexes that are a strict prefix of another index on their table (or an
-- exact copy of a unique one): every lookup and foreign-key check keeps an
-- index (`__tests__/index-shape.test.ts`, `foreign-key-indexes.test.ts`).
DROP INDEX IF EXISTS `inventory_movements_order_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `inventory_movements_variant_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `refund_attempts_order_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `refund_attempts_source_payment_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `notification_delivery_receipts_outbox_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `media_upload_parts_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `product_attributes_slug_idx`;--> statement-breakpoint
-- Images still waiting for renditions: the dashboard's idle "anything
-- pending?" check repeats the `variant_width IS NULL` predicate verbatim.
CREATE INDEX `media_pending_variants_idx` ON `media` (`kind`,`status`,`created_at`,`id`) WHERE "media"."variant_width" IS NULL;--> statement-breakpoint
-- Store import dedupe matches emails and product names as typed.
CREATE INDEX `customers_email_norm_idx` ON `customers` (lower(trim("email")));--> statement-breakpoint
CREATE INDEX `products_name_identity_idx` ON `products` (lower(trim("name")));--> statement-breakpoint
-- Email sign-in's "deleted account?" answer reads only soft-deleted claimed accounts with a verified email.
CREATE INDEX `customers_deleted_verified_email_idx` ON `customers` (lower("email")) WHERE "customers"."deleted_at" IS NOT NULL AND "customers"."email_verified_at" IS NOT NULL AND "customers"."account_claimed_at" IS NOT NULL;--> statement-breakpoint
-- The dashboard's abandoned-checkout list, newest first.
CREATE INDEX `abandoned_checkouts_updated_idx` ON `abandoned_checkouts` (`updated_at`,`id`);--> statement-breakpoint
-- The Meta Conversions API log's retention sweep deletes by age.
CREATE INDEX `meta_conversions_logs_created_idx` ON `meta_conversions_logs` (`created_at`,`id`);--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (192, '0192_lean_indexes_and_triggers', '3232b15951c34cd992c88ec330a1d3332b4055540a0786814bbba6916e891c3f');
