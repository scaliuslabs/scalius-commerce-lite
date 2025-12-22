CREATE TABLE `abandoned_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`checkout_id` text NOT NULL,
	`customer_phone` text,
	`checkout_data` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ab_checkout_id_unique` ON `abandoned_checkouts` (`checkout_id`);--> statement-breakpoint
CREATE TABLE `admin_fcm_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`device_info` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_fcm_tokens_token_unique` ON `admin_fcm_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `analytics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`use_partytown` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`location` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image_url` text,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `checkout_languages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`language_data` text NOT NULL,
	`field_visibility` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_languages_code_unique` ON `checkout_languages` (`code`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `customer_history` (
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `customers` (
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `delivery_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`external_ids` text NOT NULL,
	`metadata` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `delivery_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`credentials` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`external_id` text,
	`tracking_id` text,
	`status` text NOT NULL,
	`raw_status` text,
	`metadata` text,
	`last_checked` integer,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `delivery_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discount_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discount_products` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`product_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discount_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`amount_discounted` real NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discounts` (
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `hero_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hero_sliders` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`images` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `meta_conversions_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`event_name` text NOT NULL,
	`status` text NOT NULL,
	`request_payload` text NOT NULL,
	`response_payload` text,
	`error_message` text,
	`event_time` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meta_conversions_logs_event_id_unique` ON `meta_conversions_logs` (`event_id`);--> statement-breakpoint
CREATE TABLE `meta_conversions_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`pixel_id` text,
	`access_token` text,
	`test_event_code` text,
	`is_enabled` integer DEFAULT false NOT NULL,
	`log_retention_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`quantity` integer NOT NULL,
	`price` real NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text NOT NULL,
	`customer_email` text,
	`shipping_address` text NOT NULL,
	`city` text NOT NULL,
	`zone` text NOT NULL,
	`area` text,
	`city_name` text,
	`zone_name` text,
	`area_name` text,
	`total_amount` real NOT NULL,
	`shipping_charge` real NOT NULL,
	`discount_amount` real DEFAULT 0,
	`status` text DEFAULT 'pending' NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	`customer_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `page_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pages` (
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `product_attribute_values` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`attribute_id` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attribute_id`) REFERENCES `product_attributes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_attribute_values_product_id_attribute_id_unique` ON `product_attribute_values` (`product_id`,`attribute_id`);--> statement-breakpoint
CREATE TABLE `product_attributes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`filterable` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_attributes_name_unique` ON `product_attributes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_attributes_slug_unique` ON `product_attributes` (`slug`);--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`url` text NOT NULL,
	`alt` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_rich_content` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`size` text,
	`color` text,
	`weight` real,
	`sku` text NOT NULL,
	`price` real NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price` real NOT NULL,
	`category_id` text NOT NULL,
	`slug` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`free_delivery` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_category` ON `settings` (`key`,`category`);--> statement-breakpoint
CREATE TABLE `shipping_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipping_methods_name_unique` ON `shipping_methods` (`name`);--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` text PRIMARY KEY NOT NULL,
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `widget_history` (
	`id` text PRIMARY KEY NOT NULL,
	`widget_id` text NOT NULL,
	`html_content` text NOT NULL,
	`css_content` text,
	`reason` text DEFAULT 'updated' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`widget_id`) REFERENCES `widgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`html_content` text NOT NULL,
	`css_content` text,
	`ai_context` text,
	`is_active` integer DEFAULT true NOT NULL,
	`display_target` text DEFAULT 'homepage' NOT NULL,
	`placement_rule` text NOT NULL,
	`reference_collection_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`reference_collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null
);
