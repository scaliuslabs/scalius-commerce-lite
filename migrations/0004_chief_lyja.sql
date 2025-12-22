CREATE INDEX `categories_slug_idx` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `pages_slug_idx` ON `pages` (`slug`);--> statement-breakpoint
CREATE INDEX `products_slug_idx` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `widgets_target_idx` ON `widgets` (`display_target`,`is_active`,`deleted_at`);