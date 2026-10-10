-- Reads that stay fast at a million orders (index work, one zero-row
-- backfill, one trigger, one FTS index; no table rebuild).
--
-- orders_sales_rollup_idx: Home's month totals and daily activity sum a
-- period from the index alone (status, shop total and currency included),
-- not from a million wide order rows (9.7 s and 24 s -> 15 and 44 ms). It
-- replaces orders_dashboard_agg_idx, its prefix.
-- product_variants_product_live_idx: a product's live, tracked SKUs. With
-- more key columns than the store-wide (track_inventory, deleted_at) index,
-- SQLite (no statistics) picks it for per-product reads instead of walking
-- every tracked SKU for each product. It replaces the product_id index.
-- order_items_product_recent_idx: a product's lines newest first, so
-- recommendations read a best seller's latest orders, not tens of thousands
-- (one product page took a minute). It replaces order_items_product_id_idx.
-- customer_order_stats: every customer gets a row (the backfill, then a
-- trigger on insert), so the customer list sorts by orders, spend and last
-- order from (value, customer_id) indexes in order; they replace the
-- single-column ones (indexes first: PostgreSQL refuses index DDL on a
-- table with pending trigger events).
-- product_reviews_fts: the moderation queue's text search reads an FTS
-- index of title, text and author instead of every review. External
-- content; the triggers rewrite it only when those columns change.
-- New indexes are created before the ones they replace are dropped.
CREATE INDEX IF NOT EXISTS `orders_sales_rollup_idx` ON `orders` (`deleted_at`, `created_at`, `status`, `total_shop_minor`, `shop_currency`);
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_dashboard_agg_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_variants_product_live_idx` ON `product_variants` (`product_id`, `deleted_at`, `track_inventory`);
--> statement-breakpoint
DROP INDEX IF EXISTS `product_variants_product_id_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_items_product_recent_idx` ON `order_items` (`product_id`, `created_at`, `order_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `order_items_product_id_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_order_stats_orders_list_idx` ON `customer_order_stats` (`orders_count`, `customer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_order_stats_spent_list_idx` ON `customer_order_stats` (`total_spent_minor`, `customer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_order_stats_last_order_list_idx` ON `customer_order_stats` (`last_order_at`, `customer_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `customer_order_stats_orders_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `customer_order_stats_spent_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `customer_order_stats_last_order_idx`;
--> statement-breakpoint
INSERT INTO `customer_order_stats` (`customer_id`) SELECT `customers`.`id` FROM `customers` WHERE NOT EXISTS (SELECT 1 FROM `customer_order_stats` WHERE `customer_order_stats`.`customer_id` = `customers`.`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `customer_order_stats_customer_ins` AFTER INSERT ON `customers`
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`) VALUES (NEW.`id`) ON CONFLICT (`customer_id`) DO NOTHING;
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `product_reviews_fts` USING fts5(
	title,
	body,
	author_display_name,
	content='product_reviews',
	content_rowid='rowid',
	tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
--> statement-breakpoint
INSERT INTO `product_reviews_fts`(`product_reviews_fts`) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_reviews_fts_after_insert`
AFTER INSERT ON `product_reviews`
BEGIN
	INSERT INTO `product_reviews_fts`(rowid, title, body, author_display_name)
	VALUES (NEW.rowid, NEW.title, NEW.body, NEW.author_display_name);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_reviews_fts_before_update`
BEFORE UPDATE OF `title`, `body`, `author_display_name` ON `product_reviews`
BEGIN
	INSERT INTO `product_reviews_fts`(`product_reviews_fts`, rowid, title, body, author_display_name)
	VALUES ('delete', OLD.rowid, OLD.title, OLD.body, OLD.author_display_name);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_reviews_fts_after_update`
AFTER UPDATE OF `title`, `body`, `author_display_name` ON `product_reviews`
BEGIN
	INSERT INTO `product_reviews_fts`(rowid, title, body, author_display_name)
	VALUES (NEW.rowid, NEW.title, NEW.body, NEW.author_display_name);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `product_reviews_fts_before_delete`
BEFORE DELETE ON `product_reviews`
BEGIN
	INSERT INTO `product_reviews_fts`(`product_reviews_fts`, rowid, title, body, author_display_name)
	VALUES ('delete', OLD.rowid, OLD.title, OLD.body, OLD.author_display_name);
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (128, '0128_scale_reads', '4e7c00ff5c929a14749b56998a7438d7400e58c10ca30d7d18ba7016e0fa6d46');
