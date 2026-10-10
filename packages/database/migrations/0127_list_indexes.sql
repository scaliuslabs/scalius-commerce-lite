-- Dashboard list indexes (index-only: no table rebuild, no trigger, no data).
--
-- Every dashboard list sort walks one index in order and ends with the
-- keyset tiebreaker `id`, so a page reads its rows from the index alone, at
-- any store size (measured on a million orders: tabs, sorts and searches fell
-- from 1-60 s to tens of milliseconds; see packages/core/src/utils/list-lead.ts).
-- Order list indexes sit inside the live (`deleted_at`) and archive
-- (`archived_at`) state the list always filters on, and follow its default
-- sort (newest first). Four updated-at list indexes the list no longer sorts
-- by, and the review queue's (created_at DESC, id) index, are replaced: each
-- new index is created before its old one is dropped.
-- cod_tracking and delivery_shipments get the lookups the COD tabs and the
-- courier-id search read first. Statements are IF [NOT] EXISTS, so a replay
-- is harmless.
CREATE INDEX IF NOT EXISTS `orders_list_updated_idx` ON `orders` (`deleted_at`, `archived_at`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_created_idx` ON `orders` (`deleted_at`, `archived_at`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_total_idx` ON `orders` (`deleted_at`, `archived_at`, `total_amount_minor`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_customer_name_idx` ON `orders` (`deleted_at`, `archived_at`, `customer_name`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_status_idx` ON `orders` (`deleted_at`, `archived_at`, `status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_payment_status_idx` ON `orders` (`deleted_at`, `archived_at`, `payment_status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_payment_method_idx` ON `orders` (`deleted_at`, `archived_at`, `payment_method`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_fulfillment_idx` ON `orders` (`deleted_at`, `archived_at`, `fulfillment_status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_channel_idx` ON `orders` (`deleted_at`, `archived_at`, `channel`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_archived_idx` ON `orders` (`deleted_at`, `created_at`, `id`) WHERE `archived_at` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_list_pickup_idx` ON `orders` (`deleted_at`, `archived_at`, `created_at`, `id`) WHERE `shipping_method_kind` = 'pickup';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_list_updated_idx` ON `products` (`deleted_at`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_list_created_idx` ON `products` (`deleted_at`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_list_name_idx` ON `products` (`deleted_at`, `name`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_list_price_idx` ON `products` (`deleted_at`, `price_minor`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_list_trash_idx` ON `products` (`updated_at`, `id`) WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_list_updated_idx` ON `customers` (`deleted_at`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_list_trash_idx` ON `customers` (`updated_at`, `id`) WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_list_created_idx` ON `customers` (`deleted_at`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_list_name_idx` ON `customers` (`deleted_at`, `name`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_reviews_status_list_idx` ON `product_reviews` (`status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_reviews_created_idx` ON `product_reviews` (`created_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cod_tracking_status_idx` ON `cod_tracking` (`cod_status`, `order_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `delivery_shipments_tracking_lookup_idx` ON `delivery_shipments` (lower(`tracking_id`));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `delivery_shipments_external_lookup_idx` ON `delivery_shipments` (lower(`external_id`));
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_archive_list_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_payment_status_list_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_payment_method_list_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_fulfillment_list_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_channel_list_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `product_reviews_status_created_idx`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (127, '0127_list_indexes', '5562ec468681e4ca1d0ceb9125b14605a939d4526ac36e4686757d341d65a621');
