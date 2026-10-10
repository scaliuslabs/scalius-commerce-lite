-- Dashboard Home: seek live restock candidates, bound the diagnostic sort,
-- and cover return probes and per-product stock sums. Index-only; replayable DDL.
CREATE INDEX IF NOT EXISTS `product_variants_product_stock_idx` ON `product_variants` (`product_id`,`deleted_at`,`track_inventory`,`id`,`stock`,`reserved_stock`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_variants_alerts_idx` ON `product_variants` (`track_inventory`,`deleted_at`,("stock" - "reserved_stock" - CASE WHEN "low_stock_threshold" IS NULL THEN 0 ELSE "low_stock_threshold" END),`id`,`product_id`,`is_default`,`low_stock_threshold`,`stock`,`reserved_stock`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_inventory_idx` ON `products` (`id`,`deleted_at`,`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_feed_diagnostics_idx` ON `products` (CAST("updated_at" AS INTEGER) DESC,CAST("created_at" AS INTEGER) DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_return_lines_sales_idx` ON `order_return_lines` (`order_id`,`order_item_id`,`return_id`,`approved_quantity`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_returns_sales_idx` ON `order_returns` (`id`,`status`);
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (130, '0130_dashboard_home_reads', '9c267be236741e264c6d958f5c811d23835bf4d98447f4185f5b8e31431a78dc');
