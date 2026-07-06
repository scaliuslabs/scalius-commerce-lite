ALTER TABLE `products` ADD `exclude_from_sitemap` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `exclude_from_product_feed` integer DEFAULT false NOT NULL;
