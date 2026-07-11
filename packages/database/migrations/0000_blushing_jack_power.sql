CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`id_token` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `admin_setup_claims` (
	`singleton_key` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`completed_user_id` text,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`completed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `admin_setup_claims_status_claim_idx` ON `admin_setup_claims` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE TABLE `admin_setup_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_setup_rate_limits_window_idx` ON `admin_setup_rate_limits` (`window_expires_at`);--> statement-breakpoint
CREATE TABLE `scanner_token_claims` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`admin_id` text NOT NULL,
	`admin_name` text NOT NULL,
	`consumed_at` integer,
	`consumed_session_hash` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scanner_token_claims_expires_idx` ON `scanner_token_claims` (`expires_at`);--> statement-breakpoint
CREATE INDEX `scanner_token_claims_admin_created_idx` ON `scanner_token_claims` (`admin_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scanner_token_claims_consumed_session_hash_uq` ON `scanner_token_claims` (`consumed_session_hash`);--> statement-breakpoint
CREATE TABLE `session` (
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
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factor_user_id_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
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
	`must_change_password` integer DEFAULT false NOT NULL,
	`must_enroll_two_factor` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `user_role_idx` ON `user` (`role`);--> statement-breakpoint
CREATE INDEX `user_super_admin_idx` ON `user` (`is_super_admin`);--> statement-breakpoint
CREATE INDEX `user_admin_onboarding_idx` ON `user` (`role`,`must_change_password`,`must_enroll_two_factor`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `permissions` (
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
CREATE UNIQUE INDEX `permissions_name_unique` ON `permissions` (`name`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_permissions_role_idx` ON `role_permissions` (`role_id`);--> statement-breakpoint
CREATE INDEX `role_permissions_permission_idx` ON `role_permissions` (`permission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_permission_unique` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `user_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`granted` integer NOT NULL,
	`assigned_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_permissions_user_idx` ON `user_permissions` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_permissions_permission_idx` ON `user_permissions` (`permission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permission_unique` ON `user_permissions` (`user_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`assigned_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_roles_user_idx` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_role_unique` ON `user_roles` (`user_id`,`role_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image_url` text,
	`meta_title` text,
	`meta_description` text,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_idx` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_deleted_at_idx` ON `categories` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `collections_deleted_at_idx` ON `collections` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`alt_text` text,
	`width` integer,
	`height` integer,
	`folder_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`folder_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_folder_id_idx` ON `media` (`folder_id`);--> statement-breakpoint
CREATE INDEX `media_deleted_at_idx` ON `media` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `media_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_folders_parent_id_idx` ON `media_folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `product_attribute_values` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`attribute_id` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attribute_id`) REFERENCES `product_attributes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_attribute_values_product_id_idx` ON `product_attribute_values` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_attribute_values_attribute_id_idx` ON `product_attribute_values` (`attribute_id`);--> statement-breakpoint
CREATE INDEX `product_attribute_values_attr_value_product_idx` ON `product_attribute_values` (`attribute_id`,`value`,`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_attribute_values_product_id_attribute_id_unique` ON `product_attribute_values` (`product_id`,`attribute_id`);--> statement-breakpoint
CREATE TABLE `product_attributes` (
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
CREATE UNIQUE INDEX `product_attributes_name_unique` ON `product_attributes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_attributes_slug_unique` ON `product_attributes` (`slug`);--> statement-breakpoint
CREATE INDEX `product_attributes_slug_idx` ON `product_attributes` (`slug`);--> statement-breakpoint
CREATE TABLE `product_images` (
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
CREATE INDEX `product_images_product_id_idx` ON `product_images` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_images_primary_idx` ON `product_images` (`product_id`,`is_primary`);--> statement-breakpoint
CREATE TABLE `product_rich_content` (
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
CREATE INDEX `product_rich_content_product_id_idx` ON `product_rich_content` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_variants` (
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
	`is_default` integer DEFAULT false NOT NULL,
	`track_inventory` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`stock_version` integer DEFAULT 1 NOT NULL,
	`low_stock_threshold` integer,
	`allow_preorder` integer DEFAULT false NOT NULL,
	`preorder_date` text,
	`preorder_message` text,
	`allow_backorder` integer DEFAULT false NOT NULL,
	`backorder_limit` integer DEFAULT 0 NOT NULL,
	`tax_class_id` text,
	`tax_classification_version` integer DEFAULT 1 NOT NULL,
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
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_unique_idx` ON `product_variants` (`sku`);--> statement-breakpoint
CREATE INDEX `product_variants_barcode_idx` ON `product_variants` (`barcode`);--> statement-breakpoint
CREATE INDEX `product_variants_default_idx` ON `product_variants` (`product_id`,`is_default`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `product_variants_track_inventory_idx` ON `product_variants` (`track_inventory`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price` real NOT NULL,
	`category_id` text,
	`slug` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`exclude_from_product_feed` integer DEFAULT false NOT NULL,
	`product_condition` text,
	`variant_option_1_label` text DEFAULT 'Size' NOT NULL,
	`variant_option_2_label` text DEFAULT 'Color' NOT NULL,
	`variant_option_1_schema` text DEFAULT 'size' NOT NULL,
	`variant_option_2_schema` text DEFAULT 'color' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`free_delivery` integer DEFAULT false NOT NULL,
	`tax_class_id` text,
	`tax_classification_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_idx` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `products_public_newest_idx` ON `products` (`is_active`,`deleted_at`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `products_public_category_newest_idx` ON `products` (`category_id`,`is_active`,`deleted_at`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `products_deleted_at_idx` ON `products` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `auth_otp_delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_key` text NOT NULL,
	`purpose` text DEFAULT 'customer_login' NOT NULL,
	`method` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`identifier_hash` text NOT NULL,
	`identifier_masked` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`provider_status` text,
	`raw_response` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`last_attempt_at` integer,
	`accepted_at` integer,
	`delivered_at` integer,
	`failed_at` integer,
	`skipped_at` integer,
	`otp_expires_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_otp_delivery_receipts_delivery_key_unique` ON `auth_otp_delivery_receipts` (`delivery_key`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_identifier_created_idx` ON `auth_otp_delivery_receipts` (`identifier_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_pending_idx` ON `auth_otp_delivery_receipts` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_claim_idx` ON `auth_otp_delivery_receipts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_provider_message_idx` ON `auth_otp_delivery_receipts` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE TABLE `customer_auth_otp_challenges` (
	`otp_key` text PRIMARY KEY NOT NULL,
	`delivery_key` text NOT NULL,
	`method` text NOT NULL,
	`channel` text NOT NULL,
	`intent` text DEFAULT 'sign_in' NOT NULL,
	`identifier_hash` text NOT NULL,
	`identifier_masked` text NOT NULL,
	`delivery_target_encrypted` text,
	`delivery_name_encrypted` text,
	`contact_email_encrypted` text,
	`phone_encrypted` text,
	`code_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`resend_available_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_auth_otp_challenges_delivery_key_unique` ON `customer_auth_otp_challenges` (`delivery_key`);--> statement-breakpoint
CREATE INDEX `customer_auth_otp_challenges_identifier_created_idx` ON `customer_auth_otp_challenges` (`identifier_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `customer_auth_otp_challenges_status_expires_idx` ON `customer_auth_otp_challenges` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `customer_auth_otp_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'ip' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `customer_auth_otp_rate_limits_window_idx` ON `customer_auth_otp_rate_limits` (`window_expires_at`);--> statement-breakpoint
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
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_history_customer_id_idx` ON `customer_history` (`customer_id`);--> statement-breakpoint
CREATE TABLE `customer_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_sessions_customer_id_idx` ON `customer_sessions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_sessions_active_expiry_idx` ON `customer_sessions` (`revoked_at`,`expires_at`);--> statement-breakpoint
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
	`account_claimed_at` integer,
	`phone_verified_at` integer,
	`email_verified_at` integer,
	`last_authenticated_at` integer,
	`profile_completion_required_at` integer,
	`profile_completed_at` integer,
	`total_orders` integer DEFAULT 0 NOT NULL,
	`total_spent` real DEFAULT 0 NOT NULL,
	`last_order_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_email_idx` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_dashboard_activity_idx` ON `customers` (`deleted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `abandoned_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`checkout_id` text NOT NULL,
	`customer_phone` text,
	`checkout_data` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `abandoned_checkouts_created_at_idx` ON `abandoned_checkouts` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `abandoned_checkouts_empty_candidate_idx` ON `abandoned_checkouts` (`customer_phone`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ab_checkout_id_unique` ON `abandoned_checkouts` (`checkout_id`);--> statement-breakpoint
CREATE TABLE `checkout_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`checkout_token` text NOT NULL,
	`order_id` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`payment_method` text,
	`total_amount` real,
	`response_payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_request_key_unique` ON `checkout_attempts` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_checkout_token_unique` ON `checkout_attempts` (`checkout_token`);--> statement-breakpoint
CREATE INDEX `checkout_attempts_order_id_idx` ON `checkout_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `checkout_attempts_status_claim_idx` ON `checkout_attempts` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE TABLE `cod_tracking` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`cod_status` text DEFAULT 'pending' NOT NULL,
	`failure_reason` text,
	`collected_by` text,
	`collected_amount` real,
	`collected_at` integer,
	`receipt_url` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_tracking_order_id_unique` ON `cod_tracking` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_item_tax_snapshots` (
	`order_item_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`tax_class_id` text,
	`tax_class_name` text,
	`unit_price_minor` integer NOT NULL,
	`quantity` integer NOT NULL,
	`gross_amount_minor` integer NOT NULL,
	`discount_minor` integer NOT NULL,
	`taxable_amount_minor` integer NOT NULL,
	`tax_minor` integer NOT NULL,
	`prices_include_tax` integer NOT NULL,
	`rate_snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_item_tax_snapshots_quantity_positive" CHECK("order_item_tax_snapshots"."quantity" > 0),
	CONSTRAINT "order_item_tax_snapshots_minor_amounts_nonnegative" CHECK((
        "order_item_tax_snapshots"."unit_price_minor" >= 0
        AND "order_item_tax_snapshots"."gross_amount_minor" >= 0
        AND "order_item_tax_snapshots"."discount_minor" >= 0
        AND "order_item_tax_snapshots"."taxable_amount_minor" >= 0
        AND "order_item_tax_snapshots"."tax_minor" >= 0
    ))
);
--> statement-breakpoint
CREATE INDEX `order_item_tax_snapshots_order_idx` ON `order_item_tax_snapshots` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`quantity` integer NOT NULL,
	`price` real NOT NULL,
	`product_name` text,
	`variant_label` text,
	`inventory_tracked` integer DEFAULT true NOT NULL,
	`unit_price_minor` integer,
	`line_subtotal_minor` integer,
	`discount_amount_minor` integer,
	`taxable_amount_minor` integer,
	`tax_amount_minor` integer DEFAULT 0 NOT NULL,
	`fulfillment_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_product_id_idx` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_id_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `order_notification_delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_key` text NOT NULL,
	`outbox_id` text NOT NULL,
	`order_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`recipient_masked` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`provider_status` text,
	`raw_response` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`last_attempt_at` integer,
	`accepted_at` integer,
	`delivered_at` integer,
	`failed_at` integer,
	`skipped_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `order_notification_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_notification_delivery_receipts_receipt_key_unique` ON `order_notification_delivery_receipts` (`receipt_key`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_outbox_id_idx` ON `order_notification_delivery_receipts` (`outbox_id`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_outbox_status_idx` ON `order_notification_delivery_receipts` (`outbox_id`,`status`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_order_id_created_at_idx` ON `order_notification_delivery_receipts` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_pending_idx` ON `order_notification_delivery_receipts` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_claim_idx` ON `order_notification_delivery_receipts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_provider_message_idx` ON `order_notification_delivery_receipts` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_provider_status_updated_idx` ON `order_notification_delivery_receipts` (`channel`,`provider`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `order_notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`order_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`queued_at` integer,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_notification_outbox_dedupe_key_unique` ON `order_notification_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `order_notification_outbox_pending_idx` ON `order_notification_outbox` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_outbox_claim_idx` ON `order_notification_outbox` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `order_notification_outbox_queued_idx` ON `order_notification_outbox` (`status`,`queued_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_outbox_order_id_idx` ON `order_notification_outbox` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_payment_recovery_challenges` (
	`challenge_key` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`method` text NOT NULL,
	`channel` text NOT NULL,
	`identifier_hash` text NOT NULL,
	`identifier_masked` text NOT NULL,
	`delivery_target_encrypted` text,
	`delivery_name_encrypted` text,
	`code_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`resend_available_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_payment_recovery_delivery_key_unique` ON `order_payment_recovery_challenges` (`delivery_key`);--> statement-breakpoint
CREATE INDEX `order_payment_recovery_order_status_expires_idx` ON `order_payment_recovery_challenges` (`order_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `order_payment_recovery_identifier_created_idx` ON `order_payment_recovery_challenges` (`identifier_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'BDT' NOT NULL,
	`payment_method` text NOT NULL,
	`payment_type` text DEFAULT 'full' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_charge_id` text,
	`sslcommerz_tran_id` text,
	`sslcommerz_val_id` text,
	`sslcommerz_bank_tran_id` text,
	`polar_checkout_id` text,
	`cod_collected_by` text,
	`cod_collected_at` integer,
	`cod_receipt_url` text,
	`metadata` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_payments_order_id_idx` ON `order_payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_payments_stripe_pi_idx` ON `order_payments` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE INDEX `order_payments_ssl_tran_idx` ON `order_payments` (`sslcommerz_tran_id`);--> statement-breakpoint
CREATE INDEX `order_payments_polar_checkout_idx` ON `order_payments` (`polar_checkout_id`);--> statement-breakpoint
CREATE TABLE `order_receipts` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`source` text DEFAULT 'checkout' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_receipts_order_id_idx` ON `order_receipts` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_receipts_status_expires_idx` ON `order_receipts` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `order_support_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`note` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `order_support_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `order_support_request_events_request_created_idx` ON `order_support_request_events` (`request_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_support_request_events_order_created_idx` ON `order_support_request_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_support_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`reason` text NOT NULL,
	`message` text,
	`active_key` text,
	`submitted_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_support_requests_active_key_unique` ON `order_support_requests` (`active_key`);--> statement-breakpoint
CREATE INDEX `order_support_requests_order_created_idx` ON `order_support_requests` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_support_requests_customer_created_idx` ON `order_support_requests` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_support_requests_status_created_idx` ON `order_support_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_support_requests_type_status_idx` ON `order_support_requests` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `order_tax_snapshots` (
	`order_id` text PRIMARY KEY NOT NULL,
	`currency_code` text NOT NULL,
	`decimal_places` integer NOT NULL,
	`display_label` text NOT NULL,
	`prices_include_tax` integer NOT NULL,
	`shipping_taxed` integer NOT NULL,
	`subtotal_minor` integer NOT NULL,
	`shipping_minor` integer NOT NULL,
	`discount_minor` integer NOT NULL,
	`taxable_minor` integer NOT NULL,
	`tax_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`settings_version` integer NOT NULL,
	`calculation_version` text NOT NULL,
	`destination_snapshot` text NOT NULL,
	`rate_snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_tax_snapshots_decimal_places_range" CHECK("order_tax_snapshots"."decimal_places" BETWEEN 0 AND 3),
	CONSTRAINT "order_tax_snapshots_display_label_length" CHECK(length("order_tax_snapshots"."display_label") BETWEEN 1 AND 80),
	CONSTRAINT "order_tax_snapshots_settings_version_nonnegative" CHECK("order_tax_snapshots"."settings_version" >= 0),
	CONSTRAINT "order_tax_snapshots_minor_amounts_nonnegative" CHECK((
        "order_tax_snapshots"."subtotal_minor" >= 0
        AND "order_tax_snapshots"."shipping_minor" >= 0
        AND "order_tax_snapshots"."discount_minor" >= 0
        AND "order_tax_snapshots"."taxable_minor" >= 0
        AND "order_tax_snapshots"."tax_minor" >= 0
        AND "order_tax_snapshots"."total_minor" >= 0
    ))
);
--> statement-breakpoint
CREATE INDEX `order_tax_snapshots_created_idx` ON `order_tax_snapshots` (`created_at`);--> statement-breakpoint
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
	`currency_code` text,
	`currency_decimal_places` integer,
	`subtotal_amount_minor` integer,
	`shipping_amount_minor` integer,
	`discount_amount_minor` integer,
	`tax_amount_minor` integer DEFAULT 0 NOT NULL,
	`total_amount_minor` integer,
	`tax_label` text,
	`prices_include_tax` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`notes` text,
	`payment_method` text DEFAULT 'cod' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`payment_intent_id` text,
	`paid_amount` real DEFAULT 0 NOT NULL,
	`balance_due` real DEFAULT 0 NOT NULL,
	`fulfillment_status` text DEFAULT 'pending' NOT NULL,
	`inventory_pool` text DEFAULT 'regular' NOT NULL,
	`inventory_action` text DEFAULT 'none' NOT NULL,
	`shipment_claim_id` text,
	`shipment_claim_expires_at` integer,
	`expected_delivery` text,
	`version` integer DEFAULT 1 NOT NULL,
	`customer_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	`invoice_number` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_payment_status_idx` ON `orders` (`payment_status`);--> statement-breakpoint
CREATE INDEX `orders_customer_id_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_created_at_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `orders_deleted_at_idx` ON `orders` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `orders_list_updated_at_idx` ON `orders` (`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_payment_status_list_idx` ON `orders` (`deleted_at`,`payment_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_payment_method_list_idx` ON `orders` (`deleted_at`,`payment_method`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_fulfillment_list_idx` ON `orders` (`deleted_at`,`fulfillment_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_payment_queue_idx` ON `orders` (`deleted_at`,`payment_method`,`payment_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_fulfillment_queue_idx` ON `orders` (`deleted_at`,`fulfillment_status`,`payment_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_dashboard_agg_idx` ON `orders` (`deleted_at`,`created_at`,`status`);--> statement-breakpoint
CREATE INDEX `orders_customer_phone_idx` ON `orders` (`customer_phone`);--> statement-breakpoint
CREATE INDEX `orders_shipment_claim_idx` ON `orders` (`shipment_claim_id`,`shipment_claim_expires_at`);--> statement-breakpoint
CREATE TABLE `payment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`total_amount` real NOT NULL,
	`deposit_amount` real NOT NULL,
	`balance_due` real NOT NULL,
	`deposit_paid_at` integer,
	`balance_paid_at` integer,
	`balance_due_date` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_plans_order_id_unique` ON `payment_plans` (`order_id`);--> statement-breakpoint
CREATE TABLE `payment_session_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_key` text NOT NULL,
	`order_id` text NOT NULL,
	`gateway` text NOT NULL,
	`payment_type` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`provider_session_id` text,
	`provider_correlation_id` text,
	`response_payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_session_attempts_attempt_key_unique` ON `payment_session_attempts` (`attempt_key`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_order_id_idx` ON `payment_session_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_status_claim_idx` ON `payment_session_attempts` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_provider_session_idx` ON `payment_session_attempts` (`gateway`,`provider_session_id`);--> statement-breakpoint
CREATE TABLE `refund_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_key` text NOT NULL,
	`refund_group_id` text NOT NULL,
	`order_id` text NOT NULL,
	`source_payment_id` text NOT NULL,
	`refund_payment_id` text NOT NULL,
	`gateway` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'BDT' NOT NULL,
	`reason` text NOT NULL,
	`request_hash` text NOT NULL,
	`provider_idempotency_key` text NOT NULL,
	`refund_reference` text NOT NULL,
	`allocation_index` integer DEFAULT 0 NOT NULL,
	`allocation_count` integer DEFAULT 1 NOT NULL,
	`source_transaction_id` text,
	`provider_refund_id` text,
	`provider_correlation_id` text,
	`provider_status` text,
	`request_payload` text,
	`response_payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_probe_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_probe_at` integer,
	`last_error` text,
	`metadata` text,
	`refunded_at` integer,
	`failed_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refund_payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_attempt_key_unique` ON `refund_attempts` (`attempt_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_provider_idempotency_key_unique` ON `refund_attempts` (`provider_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_reference_unique` ON `refund_attempts` (`refund_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_group_allocation_unique` ON `refund_attempts` (`refund_group_id`,`allocation_index`);--> statement-breakpoint
CREATE INDEX `refund_attempts_order_id_idx` ON `refund_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_order_status_idx` ON `refund_attempts` (`order_id`,`status`);--> statement-breakpoint
CREATE INDEX `refund_attempts_status_probe_idx` ON `refund_attempts` (`status`,`next_probe_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `refund_attempts_status_claim_idx` ON `refund_attempts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `refund_attempts_source_payment_id_idx` ON `refund_attempts` (`source_payment_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_source_payment_status_idx` ON `refund_attempts` (`source_payment_id`,`status`);--> statement-breakpoint
CREATE INDEX `refund_attempts_refund_payment_id_idx` ON `refund_attempts` (`refund_payment_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_provider_refund_idx` ON `refund_attempts` (`gateway`,`provider_refund_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text NOT NULL,
	`order_id` text,
	`status` text DEFAULT 'processed' NOT NULL,
	`result` text,
	`processed_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_events_provider_idx` ON `webhook_events` (`provider`);--> statement-breakpoint
CREATE INDEX `webhook_events_order_id_idx` ON `webhook_events` (`order_id`);--> statement-breakpoint
CREATE INDEX `webhook_events_status_processed_at_idx` ON `webhook_events` (`status`,`processed_at`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
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
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `inventory_movements_variant_idx` ON `inventory_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_created_at_idx` ON `inventory_movements` (`created_at`);--> statement-breakpoint
CREATE TABLE `product_low_stock_alerts` (
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
CREATE UNIQUE INDEX `product_low_stock_alerts_variant_id_unique` ON `product_low_stock_alerts` (`variant_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_product_idx` ON `product_low_stock_alerts` (`product_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_status_idx` ON `product_low_stock_alerts` (`alert_status`);--> statement-breakpoint
CREATE TABLE `delivery_locations` (
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
CREATE INDEX `delivery_locations_parent_id_idx` ON `delivery_locations` (`parent_id`);--> statement-breakpoint
CREATE INDEX `delivery_locations_type_idx` ON `delivery_locations` (`type`);--> statement-breakpoint
CREATE TABLE `delivery_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`credentials` text NOT NULL,
	`config` text NOT NULL,
	`last_test_attempt_at` integer,
	`last_test_success_at` integer,
	`last_test_failure_at` integer,
	`last_test_success_fingerprint` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_providers_type_idx` ON `delivery_providers` (`type`);--> statement-breakpoint
CREATE TABLE `delivery_shipments` (
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
CREATE INDEX `delivery_shipments_provider_status_idx` ON `delivery_shipments` (`provider_id`,`status`);--> statement-breakpoint
CREATE INDEX `delivery_shipments_order_id_idx` ON `delivery_shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `delivery_shipments_external_id_idx` ON `delivery_shipments` (`external_id`);--> statement-breakpoint
CREATE TABLE `discount_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discount_collections_discount_id_idx` ON `discount_collections` (`discount_id`);--> statement-breakpoint
CREATE INDEX `discount_collections_collection_id_idx` ON `discount_collections` (`collection_id`);--> statement-breakpoint
CREATE TABLE `discount_customer_redemptions` (
	`discount_id` text NOT NULL,
	`customer_key` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`discount_id`, `customer_key`),
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discount_customer_redemptions_order_id_idx` ON `discount_customer_redemptions` (`order_id`);--> statement-breakpoint
CREATE INDEX `discount_customer_redemptions_customer_id_idx` ON `discount_customer_redemptions` (`customer_id`);--> statement-breakpoint
CREATE TABLE `discount_products` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`product_id` text NOT NULL,
	`application_type` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discount_products_discount_id_idx` ON `discount_products` (`discount_id`);--> statement-breakpoint
CREATE INDEX `discount_products_product_id_idx` ON `discount_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `discount_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`amount_discounted` real NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discount_usage_discount_customer_idx` ON `discount_usage` (`discount_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `discount_usage_order_id_idx` ON `discount_usage` (`order_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `discounts_code_unique_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE INDEX `discounts_deleted_at_idx` ON `discounts` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `meta_capi_purchase_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`event_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`sent_at` integer,
	`skipped_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meta_capi_purchase_outbox_order_id_unique` ON `meta_capi_purchase_outbox` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meta_capi_purchase_outbox_event_id_unique` ON `meta_capi_purchase_outbox` (`event_id`);--> statement-breakpoint
CREATE INDEX `meta_capi_purchase_outbox_pending_idx` ON `meta_capi_purchase_outbox` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `meta_capi_purchase_outbox_claim_idx` ON `meta_capi_purchase_outbox` (`status`,`claim_expires_at`);--> statement-breakpoint
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
	`singleton_key` text DEFAULT 'default' NOT NULL,
	`pixel_id` text,
	`access_token` text,
	`test_event_code` text,
	`is_enabled` integer DEFAULT false NOT NULL,
	`log_retention_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meta_conversions_settings_singleton_idx` ON `meta_conversions_settings` (`singleton_key`);--> statement-breakpoint
CREATE TABLE `hero_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hero_sliders` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`images` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `page_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`is_published` integer DEFAULT true NOT NULL,
	`hide_header` integer DEFAULT false NOT NULL,
	`hide_footer` integer DEFAULT false NOT NULL,
	`hide_title` integer DEFAULT false NOT NULL,
	`featured_image` text,
	`published_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_slug_idx` ON `pages` (`slug`);--> statement-breakpoint
CREATE INDEX `pages_deleted_at_idx` ON `pages` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `admin_fcm_tokens` (
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
CREATE UNIQUE INDEX `admin_fcm_tokens_token_unique` ON `admin_fcm_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `admin_fcm_tokens_user_id_idx` ON `admin_fcm_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `analytics` (
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
CREATE INDEX `analytics_type_idx` ON `analytics` (`type`);--> statement-breakpoint
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
CREATE INDEX `checkout_languages_deleted_at_idx` ON `checkout_languages` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
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
CREATE INDEX `shipping_methods_deleted_at_idx` ON `shipping_methods` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `site_settings` (
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
CREATE UNIQUE INDEX `site_settings_singleton_idx` ON `site_settings` (`singleton_key`);--> statement-breakpoint
CREATE TABLE `storefront_cache_queue_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_name` text NOT NULL,
	`queue_message_id` text NOT NULL,
	`message_type` text NOT NULL,
	`operation_id` text,
	`source` text,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`message_timestamp` integer,
	`failed_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`replayed_at` integer,
	`replayed_by` text,
	`ignored_at` integer,
	`ignored_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storefront_cache_queue_failures_message_unique` ON `storefront_cache_queue_failures` (`queue_message_id`);--> statement-breakpoint
CREATE INDEX `storefront_cache_queue_failures_status_failed_idx` ON `storefront_cache_queue_failures` (`status`,`failed_at`);--> statement-breakpoint
CREATE INDEX `storefront_cache_queue_failures_operation_idx` ON `storefront_cache_queue_failures` (`operation_id`);--> statement-breakpoint
CREATE TABLE `tax_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_exempt` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "tax_classes_name_length" CHECK(length("tax_classes"."name") BETWEEN 1 AND 120),
	CONSTRAINT "tax_classes_version_positive" CHECK("tax_classes"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_classes_active_name_ci_unique` ON `tax_classes` (lower("name")) WHERE "tax_classes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `tax_classes_deleted_name_idx` ON `tax_classes` (`deleted_at`,`name`);--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_class_id` text NOT NULL,
	`name` text NOT NULL,
	`rate_bps` integer NOT NULL,
	`jurisdiction_type` text DEFAULT 'all' NOT NULL,
	`jurisdiction_id` text,
	`jurisdiction_label` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_compound` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tax_rates_rate_bps_range" CHECK("tax_rates"."rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "tax_rates_name_length" CHECK(length("tax_rates"."name") BETWEEN 1 AND 120),
	CONSTRAINT "tax_rates_jurisdiction_label_length" CHECK("tax_rates"."jurisdiction_label" IS NULL OR length("tax_rates"."jurisdiction_label") BETWEEN 1 AND 180),
	CONSTRAINT "tax_rates_priority_range" CHECK("tax_rates"."priority" BETWEEN 0 AND 1000),
	CONSTRAINT "tax_rates_version_positive" CHECK("tax_rates"."version" >= 1),
	CONSTRAINT "tax_rates_jurisdiction_shape" CHECK((
            ("tax_rates"."jurisdiction_type" = 'all' AND "tax_rates"."jurisdiction_id" IS NULL)
            OR
            ("tax_rates"."jurisdiction_type" IN ('city', 'zone', 'area') AND length("tax_rates"."jurisdiction_id") BETWEEN 1 AND 180)
        ))
);
--> statement-breakpoint
CREATE INDEX `tax_rates_class_active_priority_idx` ON `tax_rates` (`tax_class_id`,`deleted_at`,`is_active`,`priority`);--> statement-breakpoint
CREATE INDEX `tax_rates_jurisdiction_idx` ON `tax_rates` (`jurisdiction_type`,`jurisdiction_id`,`deleted_at`,`is_active`);--> statement-breakpoint
CREATE TABLE `tax_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`prices_include_tax` integer DEFAULT false NOT NULL,
	`tax_shipping` integer DEFAULT false NOT NULL,
	`default_tax_class_id` text,
	`shipping_tax_class_id` text,
	`display_label` text DEFAULT 'Tax' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`default_tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`shipping_tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tax_settings_singleton" CHECK("tax_settings"."id" = 'default'),
	CONSTRAINT "tax_settings_version_positive" CHECK("tax_settings"."version" >= 1),
	CONSTRAINT "tax_settings_display_label_length" CHECK(length("tax_settings"."display_label") BETWEEN 1 AND 80)
);

-- Structures that Drizzle cannot represent: partial indexes, FTS5, and
-- database-level enforcement triggers. Keep this section in the baseline.
CREATE UNIQUE INDEX idx_order_payments_polar_unique
  ON order_payments(order_id, polar_checkout_id)
  WHERE polar_checkout_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX idx_order_payments_sslcommerz_val_unique
  ON order_payments(order_id, sslcommerz_val_id)
  WHERE sslcommerz_val_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX idx_order_payments_stripe_unique
  ON order_payments(order_id, stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX meta_conversions_singleton_idx ON meta_conversions_settings(singleton_key);--> statement-breakpoint
CREATE UNIQUE INDEX orders_invoice_number_idx ON orders (invoice_number) WHERE invoice_number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_session_attempts_live_order_singleflight`
ON `payment_session_attempts` (`order_id`, `gateway`, `payment_type`)
WHERE `status` = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_one_default_per_product_idx`
ON `product_variants` (`product_id`)
WHERE `is_default` = true AND `deleted_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_live_source_payment_singleflight`
ON `refund_attempts` (`source_payment_id`)
WHERE `status` IN ('pending','processing','provider_unknown','reconcile_required');--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_provider_refund_unique`
ON `refund_attempts` (`gateway`,`provider_refund_id`)
WHERE `provider_refund_id` IS NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE abandoned_checkouts_fts USING fts5(
  customer_phone,
  checkout_id,
  checkout_data,
  content='abandoned_checkouts',
  content_rowid='rowid'
);--> statement-breakpoint
CREATE VIRTUAL TABLE categories_fts USING fts5(
  name,
  description,
  content='categories',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
CREATE VIRTUAL TABLE customers_fts USING fts5(
  name,
  phone,
  email,
  content='customers',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
CREATE VIRTUAL TABLE discounts_fts USING fts5(
  code,
  content='discounts',
  content_rowid='rowid'
);--> statement-breakpoint
CREATE VIRTUAL TABLE orders_fts USING fts5(
  customer_name,
  customer_phone,
  customer_email,
  order_id,
  content='orders',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  content_col,
  content='pages',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
CREATE VIRTUAL TABLE product_variants_fts USING fts5(
  sku,
  content='product_variants',
  content_rowid='rowid'
);--> statement-breakpoint
CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  description,
  content='products',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
CREATE TRIGGER abandoned_checkouts_fts_after_insert AFTER INSERT ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(rowid, customer_phone, checkout_id, checkout_data) VALUES (new.rowid, new.customer_phone, new.checkout_id, new.checkout_data);
END;--> statement-breakpoint
CREATE TRIGGER abandoned_checkouts_fts_after_update AFTER UPDATE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(rowid, customer_phone, checkout_id, checkout_data) VALUES (new.rowid, new.customer_phone, new.checkout_id, new.checkout_data);
END;--> statement-breakpoint
CREATE TRIGGER abandoned_checkouts_fts_before_delete BEFORE DELETE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(abandoned_checkouts_fts, rowid, customer_phone, checkout_id, checkout_data) VALUES('delete', old.rowid, old.customer_phone, old.checkout_id, old.checkout_data);
END;--> statement-breakpoint
CREATE TRIGGER abandoned_checkouts_fts_before_update BEFORE UPDATE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(abandoned_checkouts_fts, rowid, customer_phone, checkout_id, checkout_data) VALUES('delete', old.rowid, old.customer_phone, old.checkout_id, old.checkout_data);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_after_insert AFTER INSERT ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_after_update AFTER UPDATE ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_before_delete BEFORE DELETE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_before_update BEFORE UPDATE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
CREATE TRIGGER customers_fts_after_insert AFTER INSERT ON customers BEGIN
  INSERT INTO customers_fts(rowid, name, phone, email) VALUES (new.rowid, new.name, new.phone, new.email);
END;--> statement-breakpoint
CREATE TRIGGER customers_fts_after_update AFTER UPDATE ON customers BEGIN
  INSERT INTO customers_fts(rowid, name, phone, email) VALUES (new.rowid, new.name, new.phone, new.email);
END;--> statement-breakpoint
CREATE TRIGGER customers_fts_before_delete BEFORE DELETE ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, phone, email) VALUES('delete', old.rowid, old.name, old.phone, old.email);
END;--> statement-breakpoint
CREATE TRIGGER customers_fts_before_update BEFORE UPDATE ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, phone, email) VALUES('delete', old.rowid, old.name, old.phone, old.email);
END;--> statement-breakpoint
CREATE TRIGGER discount_usage_max_uses_guard
BEFORE INSERT ON discount_usage
WHEN (
    SELECT max_uses
    FROM discounts
    WHERE id = NEW.discount_id
) IS NOT NULL
AND (
    SELECT COUNT(*)
    FROM discount_usage
    WHERE discount_id = NEW.discount_id
) >= (
    SELECT max_uses
    FROM discounts
    WHERE id = NEW.discount_id
)
BEGIN
    SELECT RAISE(ABORT, 'DISCOUNT_MAX_USES_EXCEEDED');
END;--> statement-breakpoint
CREATE TRIGGER `discount_usage_one_per_customer_guard`
BEFORE INSERT ON `discount_usage`
WHEN (
    SELECT `limit_one_per_customer`
    FROM `discounts`
    WHERE `id` = NEW.`discount_id`
) = 1
BEGIN
    SELECT RAISE(ABORT, 'DISCOUNT_CUSTOMER_KEY_REQUIRED')
    WHERE NOT EXISTS (
        SELECT 1
        FROM `orders` AS new_order
        WHERE new_order.`id` = NEW.`order_id`
          AND NULLIF(TRIM(new_order.`customer_phone`), '') IS NOT NULL
    );

    SELECT RAISE(ABORT, 'DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED')
    WHERE EXISTS (
        SELECT 1
        FROM `discount_customer_redemptions` AS redemption
        JOIN `orders` AS new_order
            ON new_order.`id` = NEW.`order_id`
        WHERE redemption.`discount_id` = NEW.`discount_id`
          AND redemption.`customer_key` = 'phone:' || TRIM(new_order.`customer_phone`)
        LIMIT 1
    );

    INSERT INTO `discount_customer_redemptions` (
        `discount_id`,
        `customer_key`,
        `order_id`,
        `customer_id`,
        `created_at`
    )
    SELECT
        NEW.`discount_id`,
        'phone:' || TRIM(new_order.`customer_phone`),
        NEW.`order_id`,
        NEW.`customer_id`,
        COALESCE(NEW.`created_at`, unixepoch())
    FROM `orders` AS new_order
    WHERE new_order.`id` = NEW.`order_id`;
END;--> statement-breakpoint
CREATE TRIGGER orders_fts_after_insert AFTER INSERT ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.customer_email, new.id);
END;--> statement-breakpoint
CREATE TRIGGER orders_fts_after_update AFTER UPDATE ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.customer_email, new.id);
END;--> statement-breakpoint
CREATE TRIGGER orders_fts_before_delete BEFORE DELETE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, customer_email, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.customer_email, old.id);
END;--> statement-breakpoint
CREATE TRIGGER orders_fts_before_update BEFORE UPDATE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, customer_email, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.customer_email, old.id);
END;--> statement-breakpoint
CREATE TRIGGER pages_fts_after_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content_col) VALUES (new.rowid, new.title, new.content);
END;--> statement-breakpoint
CREATE TRIGGER pages_fts_after_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content_col) VALUES (new.rowid, new.title, new.content);
END;--> statement-breakpoint
CREATE TRIGGER pages_fts_before_delete BEFORE DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_col) VALUES('delete', old.rowid, old.title, old.content);
END;--> statement-breakpoint
CREATE TRIGGER pages_fts_before_update BEFORE UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_col) VALUES('delete', old.rowid, old.title, old.content);
END;--> statement-breakpoint
CREATE TRIGGER product_variants_fts_after_insert AFTER INSERT ON product_variants BEGIN
  INSERT INTO product_variants_fts(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint
CREATE TRIGGER product_variants_fts_after_update AFTER UPDATE ON product_variants BEGIN
  INSERT INTO product_variants_fts(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint
CREATE TRIGGER product_variants_fts_before_delete BEFORE DELETE ON product_variants BEGIN
  INSERT INTO product_variants_fts(product_variants_fts, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint
CREATE TRIGGER product_variants_fts_before_update BEFORE UPDATE ON product_variants BEGIN
  INSERT INTO product_variants_fts(product_variants_fts, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint
CREATE TRIGGER products_fts_after_insert AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER products_fts_after_update AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER products_fts_before_delete BEFORE DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
CREATE TRIGGER products_fts_before_update BEFORE UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
CREATE TRIGGER discounts_fts_after_insert AFTER INSERT ON discounts BEGIN
  INSERT INTO discounts_fts(rowid, code) VALUES (new.rowid, new.code);
END;--> statement-breakpoint
CREATE TRIGGER discounts_fts_after_update AFTER UPDATE ON discounts BEGIN
  INSERT INTO discounts_fts(rowid, code) VALUES (new.rowid, new.code);
END;--> statement-breakpoint
CREATE TRIGGER discounts_fts_before_delete BEFORE DELETE ON discounts BEGIN
  INSERT INTO discounts_fts(discounts_fts, rowid, code) VALUES('delete', old.rowid, old.code);
END;--> statement-breakpoint
CREATE TRIGGER discounts_fts_before_update BEFORE UPDATE ON discounts BEGIN
  INSERT INTO discounts_fts(discounts_fts, rowid, code) VALUES('delete', old.rowid, old.code);
END;
