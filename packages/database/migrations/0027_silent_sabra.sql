PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`is_final_shipment` integer DEFAULT false,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `delivery_providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_delivery_shipments`("id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at") SELECT "id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at" FROM `delivery_shipments`;--> statement-breakpoint
DROP TABLE `delivery_shipments`;--> statement-breakpoint
ALTER TABLE `__new_delivery_shipments` RENAME TO `delivery_shipments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `delivery_shipments_provider_status_idx` ON `delivery_shipments` (`provider_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_discount_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_discount_collections`("id", "discount_id", "collection_id", "application_type", "created_at") SELECT "id", "discount_id", "collection_id", "application_type", "created_at" FROM `discount_collections`;--> statement-breakpoint
DROP TABLE `discount_collections`;--> statement-breakpoint
ALTER TABLE `__new_discount_collections` RENAME TO `discount_collections`;--> statement-breakpoint
CREATE INDEX `discount_collections_collection_id_idx` ON `discount_collections` (`collection_id`);--> statement-breakpoint
CREATE TABLE `__new_discount_products` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`product_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_discount_products`("id", "discount_id", "product_id", "application_type", "created_at") SELECT "id", "discount_id", "product_id", "application_type", "created_at" FROM `discount_products`;--> statement-breakpoint
DROP TABLE `discount_products`;--> statement-breakpoint
ALTER TABLE `__new_discount_products` RENAME TO `discount_products`;--> statement-breakpoint
CREATE INDEX `discount_products_discount_id_idx` ON `discount_products` (`discount_id`);--> statement-breakpoint
CREATE INDEX `discount_products_product_id_idx` ON `discount_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `__new_analytics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`use_partytown` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`location` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_analytics`("id", "name", "type", "is_active", "use_partytown", "config", "location", "created_at", "updated_at") SELECT "id", "name", "type", "is_active", "use_partytown", "config", "location", "created_at", "updated_at" FROM `analytics`;--> statement-breakpoint
DROP TABLE `analytics`;--> statement-breakpoint
ALTER TABLE `__new_analytics` RENAME TO `analytics`;--> statement-breakpoint
CREATE INDEX `analytics_type_idx` ON `analytics` (`type`);--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image_url` text,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_categories`("id", "name", "slug", "description", "image_url", "meta_title", "meta_description", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "slug", "description", "image_url", "meta_title", "meta_description", "created_at", "updated_at", "deleted_at" FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
CREATE INDEX `categories_slug_idx` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_deleted_at_idx` ON `categories` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `__new_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_collections`("id", "name", "type", "config", "sort_order", "is_active", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "type", "config", "sort_order", "is_active", "created_at", "updated_at", "deleted_at" FROM `collections`;--> statement-breakpoint
DROP TABLE `collections`;--> statement-breakpoint
ALTER TABLE `__new_collections` RENAME TO `collections`;--> statement-breakpoint
CREATE INDEX `collections_deleted_at_idx` ON `collections` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `__new_customer_history` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text NOT NULL,
	`address` text,
	`city` text,
	`zone` text,
	`area` text,
	`city_name` text,
	`zone_name` text,
	`area_name` text,
	`change_type` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_customer_history`("id", "customer_id", "name", "email", "phone", "address", "city", "zone", "area", "city_name", "zone_name", "area_name", "change_type", "created_at") SELECT "id", "customer_id", "name", "email", "phone", "address", "city", "zone", "area", "city_name", "zone_name", "area_name", "change_type", "created_at" FROM `customer_history`;--> statement-breakpoint
DROP TABLE `customer_history`;--> statement-breakpoint
ALTER TABLE `__new_customer_history` RENAME TO `customer_history`;--> statement-breakpoint
CREATE INDEX `customer_history_customer_id_idx` ON `customer_history` (`customer_id`);--> statement-breakpoint
CREATE TABLE `__new_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text NOT NULL,
	`address` text,
	`city` text,
	`zone` text,
	`area` text,
	`city_name` text,
	`zone_name` text,
	`area_name` text,
	`total_orders` integer DEFAULT 0 NOT NULL,
	`total_spent` real DEFAULT 0 NOT NULL,
	`last_order_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_customers`("id", "name", "email", "phone", "address", "city", "zone", "area", "city_name", "zone_name", "area_name", "total_orders", "total_spent", "last_order_at", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "email", "phone", "address", "city", "zone", "area", "city_name", "zone_name", "area_name", "total_orders", "total_spent", "last_order_at", "created_at", "updated_at", "deleted_at" FROM `customers`;--> statement-breakpoint
DROP TABLE `customers`;--> statement-breakpoint
ALTER TABLE `__new_customers` RENAME TO `customers`;--> statement-breakpoint
CREATE UNIQUE INDEX `customer_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_email_idx` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `__new_delivery_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`external_ids` text NOT NULL,
	`metadata` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `delivery_locations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_delivery_locations`("id", "name", "type", "parent_id", "external_ids", "metadata", "is_active", "sort_order", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "type", "parent_id", "external_ids", "metadata", "is_active", "sort_order", "created_at", "updated_at", "deleted_at" FROM `delivery_locations`;--> statement-breakpoint
DROP TABLE `delivery_locations`;--> statement-breakpoint
ALTER TABLE `__new_delivery_locations` RENAME TO `delivery_locations`;--> statement-breakpoint
CREATE INDEX `delivery_locations_parent_id_idx` ON `delivery_locations` (`parent_id`);--> statement-breakpoint
CREATE TABLE `__new_delivery_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`credentials` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_delivery_providers`("id", "name", "type", "is_active", "credentials", "config", "created_at", "updated_at") SELECT "id", "name", "type", "is_active", "credentials", "config", "created_at", "updated_at" FROM `delivery_providers`;--> statement-breakpoint
DROP TABLE `delivery_providers`;--> statement-breakpoint
ALTER TABLE `__new_delivery_providers` RENAME TO `delivery_providers`;--> statement-breakpoint
CREATE INDEX `delivery_providers_type_idx` ON `delivery_providers` (`type`);--> statement-breakpoint
CREATE TABLE `__new_discount_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`amount_discounted` real NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_discount_usage`("id", "discount_id", "order_id", "customer_id", "amount_discounted", "created_at") SELECT "id", "discount_id", "order_id", "customer_id", "amount_discounted", "created_at" FROM `discount_usage`;--> statement-breakpoint
DROP TABLE `discount_usage`;--> statement-breakpoint
ALTER TABLE `__new_discount_usage` RENAME TO `discount_usage`;--> statement-breakpoint
CREATE INDEX `discount_usage_discount_customer_idx` ON `discount_usage` (`discount_id`,`customer_id`);--> statement-breakpoint
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
	`limit_one_per_customer` integer DEFAULT false,
	`combine_with_product_discounts` integer DEFAULT false,
	`combine_with_order_discounts` integer DEFAULT false,
	`combine_with_shipping_discounts` integer DEFAULT false,
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
CREATE TABLE `__new_hero_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_hero_sections`("id", "name", "type", "is_active", "config", "created_at", "updated_at") SELECT "id", "name", "type", "is_active", "config", "created_at", "updated_at" FROM `hero_sections`;--> statement-breakpoint
DROP TABLE `hero_sections`;--> statement-breakpoint
ALTER TABLE `__new_hero_sections` RENAME TO `hero_sections`;--> statement-breakpoint
CREATE TABLE `__new_hero_sliders` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`images` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_hero_sliders`("id", "type", "images", "is_active", "created_at", "updated_at", "deleted_at") SELECT "id", "type", "images", "is_active", "created_at", "updated_at", "deleted_at" FROM `hero_sliders`;--> statement-breakpoint
DROP TABLE `hero_sliders`;--> statement-breakpoint
ALTER TABLE `__new_hero_sliders` RENAME TO `hero_sliders`;--> statement-breakpoint
CREATE TABLE `__new_media` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`folder_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`folder_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_media`("id", "filename", "url", "size", "mime_type", "folder_id", "created_at", "updated_at", "deleted_at") SELECT "id", "filename", "url", "size", "mime_type", "folder_id", "created_at", "updated_at", "deleted_at" FROM `media`;--> statement-breakpoint
DROP TABLE `media`;--> statement-breakpoint
ALTER TABLE `__new_media` RENAME TO `media`;--> statement-breakpoint
CREATE INDEX `media_folder_id_idx` ON `media` (`folder_id`);--> statement-breakpoint
CREATE INDEX `media_deleted_at_idx` ON `media` (`deleted_at`);--> statement-breakpoint
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
INSERT INTO `__new_media_folders`("id", "name", "parent_id", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "parent_id", "created_at", "updated_at", "deleted_at" FROM `media_folders`;--> statement-breakpoint
DROP TABLE `media_folders`;--> statement-breakpoint
ALTER TABLE `__new_media_folders` RENAME TO `media_folders`;--> statement-breakpoint
CREATE TABLE `__new_page_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_page_templates`("id", "name", "type", "is_active", "config", "created_at", "updated_at") SELECT "id", "name", "type", "is_active", "config", "created_at", "updated_at" FROM `page_templates`;--> statement-breakpoint
DROP TABLE `page_templates`;--> statement-breakpoint
ALTER TABLE `__new_page_templates` RENAME TO `page_templates`;--> statement-breakpoint
CREATE TABLE `__new_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`is_published` integer DEFAULT true NOT NULL,
	`hide_header` integer DEFAULT false NOT NULL,
	`hide_footer` integer DEFAULT false NOT NULL,
	`hide_title` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_pages`("id", "title", "slug", "content", "meta_title", "meta_description", "is_published", "hide_header", "hide_footer", "hide_title", "published_at", "sort_order", "created_at", "updated_at", "deleted_at") SELECT "id", "title", "slug", "content", "meta_title", "meta_description", "is_published", "hide_header", "hide_footer", "hide_title", "published_at", "sort_order", "created_at", "updated_at", "deleted_at" FROM `pages`;--> statement-breakpoint
DROP TABLE `pages`;--> statement-breakpoint
ALTER TABLE `__new_pages` RENAME TO `pages`;--> statement-breakpoint
CREATE INDEX `pages_slug_idx` ON `pages` (`slug`);--> statement-breakpoint
CREATE INDEX `pages_deleted_at_idx` ON `pages` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `__new_product_attribute_values` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`attribute_id` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attribute_id`) REFERENCES `product_attributes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_product_attribute_values`("id", "product_id", "attribute_id", "value", "created_at") SELECT "id", "product_id", "attribute_id", "value", "created_at" FROM `product_attribute_values`;--> statement-breakpoint
DROP TABLE `product_attribute_values`;--> statement-breakpoint
ALTER TABLE `__new_product_attribute_values` RENAME TO `product_attribute_values`;--> statement-breakpoint
CREATE INDEX `product_attribute_values_product_id_idx` ON `product_attribute_values` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_attribute_values_product_id_attribute_id_unique` ON `product_attribute_values` (`product_id`,`attribute_id`);--> statement-breakpoint
CREATE TABLE `__new_product_attributes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`filterable` integer DEFAULT true NOT NULL,
	`options` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_product_attributes`("id", "name", "slug", "filterable", "options", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "slug", "filterable", "options", "created_at", "updated_at", "deleted_at" FROM `product_attributes`;--> statement-breakpoint
DROP TABLE `product_attributes`;--> statement-breakpoint
ALTER TABLE `__new_product_attributes` RENAME TO `product_attributes`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_attributes_name_unique` ON `product_attributes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_attributes_slug_unique` ON `product_attributes` (`slug`);--> statement-breakpoint
CREATE INDEX `product_attributes_slug_idx` ON `product_attributes` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`url` text NOT NULL,
	`alt` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_product_images`("id", "product_id", "url", "alt", "is_primary", "sort_order", "created_at") SELECT "id", "product_id", "url", "alt", "is_primary", "sort_order", "created_at" FROM `product_images`;--> statement-breakpoint
DROP TABLE `product_images`;--> statement-breakpoint
ALTER TABLE `__new_product_images` RENAME TO `product_images`;--> statement-breakpoint
CREATE INDEX `product_images_product_id_idx` ON `product_images` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_images_primary_idx` ON `product_images` (`product_id`,`is_primary`);--> statement-breakpoint
CREATE TABLE `__new_product_rich_content` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_product_rich_content`("id", "product_id", "title", "content", "sort_order", "created_at", "updated_at") SELECT "id", "product_id", "title", "content", "sort_order", "created_at", "updated_at" FROM `product_rich_content`;--> statement-breakpoint
DROP TABLE `product_rich_content`;--> statement-breakpoint
ALTER TABLE `__new_product_rich_content` RENAME TO `product_rich_content`;--> statement-breakpoint
CREATE INDEX `product_rich_content_product_id_idx` ON `product_rich_content` (`product_id`);--> statement-breakpoint
CREATE TABLE `__new_product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`size` text,
	`color` text,
	`weight` real,
	`sku` text NOT NULL,
	`price` real NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`reserved_stock` integer DEFAULT 0 NOT NULL,
	`preorder_stock` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`stock_version` integer DEFAULT 1 NOT NULL,
	`low_stock_threshold` integer,
	`allow_preorder` integer DEFAULT false NOT NULL,
	`preorder_date` text,
	`preorder_message` text,
	`allow_backorder` integer DEFAULT false NOT NULL,
	`backorder_limit` integer DEFAULT 0 NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`barcode` text,
	`barcode_type` text,
	`color_sort_order` integer DEFAULT 0,
	`size_sort_order` integer DEFAULT 0,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_product_variants`("id", "product_id", "size", "color", "weight", "sku", "price", "stock", "reserved_stock", "preorder_stock", "version", "stock_version", "low_stock_threshold", "allow_preorder", "preorder_date", "preorder_message", "allow_backorder", "backorder_limit", "discount_percentage", "discount_type", "discount_amount", "barcode", "barcode_type", "color_sort_order", "size_sort_order", "created_at", "updated_at", "deleted_at") SELECT "id", "product_id", "size", "color", "weight", "sku", "price", "stock", "reserved_stock", "preorder_stock", "version", "stock_version", "low_stock_threshold", "allow_preorder", "preorder_date", "preorder_message", "allow_backorder", "backorder_limit", "discount_percentage", "discount_type", "discount_amount", "barcode", "barcode_type", "color_sort_order", "size_sort_order", "created_at", "updated_at", "deleted_at" FROM `product_variants`;--> statement-breakpoint
DROP TABLE `product_variants`;--> statement-breakpoint
ALTER TABLE `__new_product_variants` RENAME TO `product_variants`;--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_variants_sku_idx` ON `product_variants` (`sku`);--> statement-breakpoint
CREATE INDEX `product_variants_barcode_idx` ON `product_variants` (`barcode`);--> statement-breakpoint
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
INSERT INTO `__new_products`("id", "name", "description", "price", "category_id", "slug", "meta_title", "meta_description", "created_at", "updated_at", "deleted_at", "is_active", "discount_percentage", "discount_type", "discount_amount", "free_delivery") SELECT "id", "name", "description", "price", "category_id", "slug", "meta_title", "meta_description", "created_at", "updated_at", "deleted_at", "is_active", "discount_percentage", "discount_type", "discount_amount", "free_delivery" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
CREATE INDEX `products_slug_idx` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `products_deleted_at_idx` ON `products` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "key", "value", "type", "category", "updated_at", "expires_at") SELECT "id", "key", "value", "type", "category", "updated_at", "expires_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_category` ON `settings` (`key`,`category`);--> statement-breakpoint
CREATE TABLE `__new_site_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` text DEFAULT 'default' NOT NULL,
	`logo` text,
	`favicon` text,
	`site_name` text NOT NULL,
	`site_description` text,
	`header_config` text NOT NULL,
	`footer_config` text NOT NULL,
	`social_links` text,
	`contact_info` text,
	`site_title` text,
	`homepage_title` text,
	`homepage_meta_description` text,
	`robots_txt` text,
	`storefront_url` text DEFAULT '/',
	`auth_verification_method` text DEFAULT 'email' NOT NULL,
	`guest_checkout_enabled` integer DEFAULT true NOT NULL,
	`checkout_mode` text DEFAULT 'all' NOT NULL,
	`partial_payment_enabled` integer DEFAULT false NOT NULL,
	`partial_payment_amount` real DEFAULT 0 NOT NULL,
	`whatsapp_access_token` text,
	`whatsapp_phone_number_id` text,
	`whatsapp_template_name` text DEFAULT 'auth_otp',
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_site_settings`("id", "singleton_key", "logo", "favicon", "site_name", "site_description", "header_config", "footer_config", "social_links", "contact_info", "site_title", "homepage_title", "homepage_meta_description", "robots_txt", "storefront_url", "auth_verification_method", "guest_checkout_enabled", "checkout_mode", "partial_payment_enabled", "partial_payment_amount", "whatsapp_access_token", "whatsapp_phone_number_id", "whatsapp_template_name", "created_at", "updated_at") SELECT "id", "singleton_key", "logo", "favicon", "site_name", "site_description", "header_config", "footer_config", "social_links", "contact_info", "site_title", "homepage_title", "homepage_meta_description", "robots_txt", "storefront_url", "auth_verification_method", "guest_checkout_enabled", "checkout_mode", "partial_payment_enabled", "partial_payment_amount", "whatsapp_access_token", "whatsapp_phone_number_id", "whatsapp_template_name", "created_at", "updated_at" FROM `site_settings`;--> statement-breakpoint
DROP TABLE `site_settings`;--> statement-breakpoint
ALTER TABLE `__new_site_settings` RENAME TO `site_settings`;--> statement-breakpoint
ALTER TABLE `meta_conversions_settings` ADD `singleton_key` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `permissions` ADD `updated_at` integer DEFAULT (cast(strftime('%s','now') as int));--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
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
INSERT INTO `__new_admin_fcm_tokens`("id", "user_id", "token", "device_info", "is_active", "last_used", "created_at", "updated_at") SELECT "id", "user_id", "token", "device_info", "is_active", "last_used", "created_at", "updated_at" FROM `admin_fcm_tokens`;--> statement-breakpoint
DROP TABLE `admin_fcm_tokens`;--> statement-breakpoint
ALTER TABLE `__new_admin_fcm_tokens` RENAME TO `admin_fcm_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `admin_fcm_tokens_token_unique` ON `admin_fcm_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `admin_fcm_tokens_user_id_idx` ON `admin_fcm_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`quantity` integer NOT NULL,
	`price` real NOT NULL,
	`product_name` text,
	`variant_label` text,
	`fulfillment_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_order_items`("id", "order_id", "product_id", "variant_id", "quantity", "price", "product_name", "variant_label", "fulfillment_status", "created_at") SELECT "id", "order_id", "product_id", "variant_id", "quantity", "price", "product_name", "variant_label", "fulfillment_status", "created_at" FROM `order_items`;--> statement-breakpoint
DROP TABLE `order_items`;--> statement-breakpoint
ALTER TABLE `__new_order_items` RENAME TO `order_items`;--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_product_id_idx` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_id_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `shipping_methods_deleted_at_idx` ON `shipping_methods` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `widget_history_widget_id_idx` ON `widget_history` (`widget_id`);--> statement-breakpoint
CREATE INDEX `widgets_deleted_at_idx` ON `widgets` (`deleted_at`);--> statement-breakpoint
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
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_inventory_movements`("id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock", "notes", "created_by", "created_at") SELECT "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock", "notes", "created_by", "created_at" FROM `inventory_movements`;--> statement-breakpoint
DROP TABLE `inventory_movements`;--> statement-breakpoint
ALTER TABLE `__new_inventory_movements` RENAME TO `inventory_movements`;--> statement-breakpoint
CREATE INDEX `inventory_movements_variant_idx` ON `inventory_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_created_at_idx` ON `inventory_movements` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_product_low_stock_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`current_qty` integer NOT NULL,
	`threshold` integer NOT NULL,
	`alert_status` text DEFAULT 'active' NOT NULL,
	`alert_sent_at` integer,
	`acknowledged_at` integer,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_product_low_stock_alerts`("id", "variant_id", "product_id", "current_qty", "threshold", "alert_status", "alert_sent_at", "acknowledged_at", "resolved_at", "created_at", "updated_at") SELECT "id", "variant_id", "product_id", "current_qty", "threshold", "alert_status", "alert_sent_at", "acknowledged_at", "resolved_at", "created_at", "updated_at" FROM `product_low_stock_alerts`;--> statement-breakpoint
DROP TABLE `product_low_stock_alerts`;--> statement-breakpoint
ALTER TABLE `__new_product_low_stock_alerts` RENAME TO `product_low_stock_alerts`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_low_stock_alerts_variant_id_unique` ON `product_low_stock_alerts` (`variant_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_product_idx` ON `product_low_stock_alerts` (`product_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_status_idx` ON `product_low_stock_alerts` (`alert_status`);