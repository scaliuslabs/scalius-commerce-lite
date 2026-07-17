ALTER TABLE `orders` ADD `archived_at` integer;--> statement-breakpoint
CREATE INDEX `orders_archived_at_idx` ON `orders` (`archived_at`);--> statement-breakpoint
CREATE INDEX `orders_archive_list_idx` ON `orders` (`deleted_at`,`archived_at`,`updated_at`);