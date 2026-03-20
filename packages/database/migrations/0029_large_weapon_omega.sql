DROP INDEX `product_variants_sku_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_unique_idx` ON `product_variants` (`sku`);--> statement-breakpoint
DROP INDEX `discounts_code_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `discounts_code_unique_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `meta_conversions_settings_singleton_idx` ON `meta_conversions_settings` (`singleton_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_settings_singleton_idx` ON `site_settings` (`singleton_key`);