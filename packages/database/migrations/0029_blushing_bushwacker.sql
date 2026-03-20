PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`order_id` text,
	`type` text NOT NULL,
	`quantity` integer NOT NULL,
	`previous_stock` integer NOT NULL,
	`new_stock` integer NOT NULL,
	`notes` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_inventory_movements`("id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock", "notes", "created_by", "created_at") SELECT "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock", "notes", "created_by", "created_at" FROM `inventory_movements`;--> statement-breakpoint
DROP TABLE `inventory_movements`;--> statement-breakpoint
ALTER TABLE `__new_inventory_movements` RENAME TO `inventory_movements`;--> statement-breakpoint
CREATE INDEX `inventory_movements_variant_idx` ON `inventory_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_created_at_idx` ON `inventory_movements` (`created_at`);--> statement-breakpoint
DROP INDEX `product_variants_sku_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_unique_idx` ON `product_variants` (`sku`);--> statement-breakpoint
DROP INDEX `discounts_code_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `discounts_code_unique_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE TABLE `__new_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`category` text NOT NULL,
	`is_sensitive` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_permissions`("id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive", "created_at", "updated_at") SELECT "id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive", "created_at", "updated_at" FROM `permissions`;--> statement-breakpoint
DROP TABLE `permissions`;--> statement-breakpoint
ALTER TABLE `__new_permissions` RENAME TO `permissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_name_unique` ON `permissions` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `meta_conversions_settings_singleton_idx` ON `meta_conversions_settings` (`singleton_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_settings_singleton_idx` ON `site_settings` (`singleton_key`);--> statement-breakpoint
PRAGMA foreign_keys=ON;