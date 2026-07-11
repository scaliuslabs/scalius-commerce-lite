ALTER TABLE `inventory_movements` ADD `ledger_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `pool` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `reservation_generation` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `stock_version_before` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `stock_version_after` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `stock_delta` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `previous_reserved_stock` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `new_reserved_stock` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `reserved_stock_delta` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `previous_preorder_stock` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `new_preorder_stock` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `preorder_stock_delta` integer;--> statement-breakpoint
CREATE INDEX `inventory_movements_generation_idx` ON `inventory_movements` (`order_id`,`variant_id`,`pool`,`reservation_generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_movements_variant_version_uidx` ON `inventory_movements` (`variant_id`,`stock_version_after`);