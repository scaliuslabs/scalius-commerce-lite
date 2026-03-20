DROP INDEX IF EXISTS `product_variants_sku_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_variants_sku_unique_idx` ON `product_variants` (`sku`);--> statement-breakpoint
DROP INDEX IF EXISTS `discounts_code_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `discounts_code_unique_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `meta_conversions_settings_singleton_idx` ON `meta_conversions_settings` (`singleton_key`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_settings_singleton_idx` ON `site_settings` (`singleton_key`);