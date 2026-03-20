DROP INDEX `categories_slug_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_idx` ON `categories` (`slug`);--> statement-breakpoint
DROP INDEX `products_slug_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_idx` ON `products` (`slug`);--> statement-breakpoint
DROP INDEX `pages_slug_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `pages_slug_idx` ON `pages` (`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`impersonated_by` text,
	`two_factor_verified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session`("id", "user_id", "token", "expires_at", "ip_address", "user_agent", "impersonated_by", "two_factor_verified", "created_at", "updated_at") SELECT "id", "user_id", "token", "expires_at", "ip_address", "user_agent", "impersonated_by", "two_factor_verified", "created_at", "updated_at" FROM `session`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
ALTER TABLE `__new_session` RENAME TO `session`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'user',
	`is_super_admin` integer DEFAULT false NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer,
	`two_factor_enabled` integer DEFAULT false NOT NULL,
	`two_factor_method` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user`("id", "name", "email", "email_verified", "image", "role", "is_super_admin", "banned", "ban_reason", "ban_expires", "two_factor_enabled", "two_factor_method", "created_at", "updated_at") SELECT "id", "name", "email", "email_verified", "image", "role", "is_super_admin", "banned", "ban_reason", "ban_expires", "two_factor_enabled", "two_factor_method", "created_at", "updated_at" FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `__new_delivery_shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider_id` text,
	`provider_type` text DEFAULT 'manual' NOT NULL,
	`external_id` text,
	`tracking_id` text,
	`tracking_url` text,
	`courier_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`raw_status` text,
	`note` text,
	`metadata` text,
	`last_checked` integer,
	`shipment_items` text,
	`shipment_amount` real,
	`is_final_shipment` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `delivery_providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_delivery_shipments`("id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at") SELECT "id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at" FROM `delivery_shipments`;--> statement-breakpoint
DROP TABLE `delivery_shipments`;--> statement-breakpoint
ALTER TABLE `__new_delivery_shipments` RENAME TO `delivery_shipments`;--> statement-breakpoint
CREATE INDEX `delivery_shipments_provider_status_idx` ON `delivery_shipments` (`provider_id`,`status`);--> statement-breakpoint
CREATE INDEX `delivery_shipments_order_id_idx` ON `delivery_shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `delivery_shipments_external_id_idx` ON `delivery_shipments` (`external_id`);--> statement-breakpoint
CREATE TABLE `__new_discounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`value_type` text NOT NULL,
	`discount_value` real NOT NULL,
	`min_purchase_amount` real,
	`min_quantity` integer,
	`max_uses_per_order` integer,
	`max_uses` integer,
	`limit_one_per_customer` integer DEFAULT false NOT NULL,
	`combine_with_product_discounts` integer DEFAULT false NOT NULL,
	`combine_with_order_discounts` integer DEFAULT false NOT NULL,
	`combine_with_shipping_discounts` integer DEFAULT false NOT NULL,
	`customer_segment` text,
	`start_date` integer NOT NULL,
	`end_date` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_discounts`("id", "code", "type", "value_type", "discount_value", "min_purchase_amount", "min_quantity", "max_uses_per_order", "max_uses", "limit_one_per_customer", "combine_with_product_discounts", "combine_with_order_discounts", "combine_with_shipping_discounts", "customer_segment", "start_date", "end_date", "is_active", "created_at", "updated_at", "deleted_at") SELECT "id", "code", "type", "value_type", "discount_value", "min_purchase_amount", "min_quantity", "max_uses_per_order", "max_uses", "limit_one_per_customer", "combine_with_product_discounts", "combine_with_order_discounts", "combine_with_shipping_discounts", "customer_segment", "start_date", "end_date", "is_active", "created_at", "updated_at", "deleted_at" FROM `discounts`;--> statement-breakpoint
DROP TABLE `discounts`;--> statement-breakpoint
ALTER TABLE `__new_discounts` RENAME TO `discounts`;--> statement-breakpoint
CREATE INDEX `discounts_code_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE INDEX `discounts_deleted_at_idx` ON `discounts` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `product_attribute_values_attribute_id_idx` ON `product_attribute_values` (`attribute_id`);--> statement-breakpoint
CREATE INDEX `discount_collections_discount_id_idx` ON `discount_collections` (`discount_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;