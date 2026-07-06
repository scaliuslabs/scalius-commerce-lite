ALTER TABLE `products` ADD `no_index` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `categories` ADD `no_index` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `categories` ADD `exclude_from_sitemap` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `collections` ADD `no_index` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `collections` ADD `exclude_from_sitemap` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `pages` ADD `no_index` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `pages` ADD `exclude_from_sitemap` integer DEFAULT false NOT NULL;
