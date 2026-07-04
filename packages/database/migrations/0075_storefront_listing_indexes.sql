CREATE INDEX IF NOT EXISTS `products_public_newest_idx`
ON `products` (`is_active`, `deleted_at`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_public_category_newest_idx`
ON `products` (`category_id`, `is_active`, `deleted_at`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_attribute_values_attr_value_product_idx`
ON `product_attribute_values` (`attribute_id`, `value`, `product_id`);
--> statement-breakpoint
PRAGMA optimize;
