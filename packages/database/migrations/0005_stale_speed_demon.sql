CREATE INDEX `delivery_locations_type_parent_active_idx` ON `delivery_locations` (`type`,`parent_id`,`is_active`,`deleted_at`,`sort_order`,`name`);--> statement-breakpoint
CREATE INDEX `hero_sliders_type_active_deleted_idx` ON `hero_sliders` (`type`,`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `product_attr_values_attribute_value_idx` ON `product_attribute_values` (`attribute_id`,`value`);--> statement-breakpoint
CREATE INDEX `product_images_product_primary_sort_idx` ON `product_images` (`product_id`,`is_primary`,`sort_order`);--> statement-breakpoint
CREATE INDEX `product_rich_content_product_sort_idx` ON `product_rich_content` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `product_variants_product_deleted_idx` ON `product_variants` (`product_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `shipping_methods_active_deleted_sort_idx` ON `shipping_methods` (`is_active`,`deleted_at`,`sort_order`,`name`);