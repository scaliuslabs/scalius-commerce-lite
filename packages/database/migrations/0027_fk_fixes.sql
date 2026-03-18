-- Fix 3 FK constraints:
-- 1. products.category_id: remove NOT NULL to allow onDelete: set null
-- 2. admin_fcm_tokens.user_id: add FK reference to user(id) with cascade delete
-- 3. media_folders.parent_id: add self-referential FK with set null

-- SQLite doesn't support ALTER TABLE to modify constraints directly,
-- so we use the create-copy-drop-rename pattern for each affected table.

-- 1. Fix products.category_id (remove NOT NULL, keep FK with onDelete: set null)
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price` real NOT NULL,
	`category_id` text,
	`slug` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`free_delivery` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_products` SELECT * FROM `products`;
--> statement-breakpoint
DROP TABLE `products`;
--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;
--> statement-breakpoint
CREATE INDEX `products_slug_idx` ON `products` (`slug`);
--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);
--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `products_deleted_at_idx` ON `products` (`deleted_at`);
--> statement-breakpoint

-- 2. Fix admin_fcm_tokens.user_id (add FK to user.id with cascade delete)
CREATE TABLE `__new_admin_fcm_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`device_info` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_admin_fcm_tokens` SELECT * FROM `admin_fcm_tokens`;
--> statement-breakpoint
DROP TABLE `admin_fcm_tokens`;
--> statement-breakpoint
ALTER TABLE `__new_admin_fcm_tokens` RENAME TO `admin_fcm_tokens`;
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_fcm_tokens_token_unique` ON `admin_fcm_tokens` (`token`);
--> statement-breakpoint
CREATE INDEX `admin_fcm_tokens_user_id_idx` ON `admin_fcm_tokens` (`user_id`);
--> statement-breakpoint

-- 3. Fix media_folders.parent_id (add self-referential FK with set null)
CREATE TABLE `__new_media_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_media_folders` SELECT * FROM `media_folders`;
--> statement-breakpoint
DROP TABLE `media_folders`;
--> statement-breakpoint
ALTER TABLE `__new_media_folders` RENAME TO `media_folders`;
