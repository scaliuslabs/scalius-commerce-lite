-- Digital goods (Wave B §3, §6.3). Expand-only: new tables, one trigger and a
-- partial index. Files are private R2 objects under `private/digital/`;
-- licence keys are encrypted at rest and assigned at most once (D2: only
-- available -> assigned|revoked, and assignment is final); an entitlement's
-- download count never passes its limit (D4). The partial index on
-- `order_items` holds only the lines an automatic fulfiller still owes, so the
-- 15-minute auto-fulfil sweep no longer visits every settled order.
CREATE TABLE `digital_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`display_name` text NOT NULL,
	`filename` text,
	`media_type` text,
	`size_bytes` integer,
	`current_r2_key` text,
	`download_limit` integer DEFAULT 5,
	`access_days` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "digital_assets_id_shape" CHECK(substr("digital_assets"."id", 1, 4) = 'dga_' AND length("digital_assets"."id") BETWEEN 12 AND 68),
	CONSTRAINT "digital_assets_kind_check" CHECK("digital_assets"."kind" IN ('file', 'licence_keys')),
	CONSTRAINT "digital_assets_status_check" CHECK("digital_assets"."status" IN ('draft', 'ready', 'archived')),
	CONSTRAINT "digital_assets_display_name_length" CHECK(length(trim("digital_assets"."display_name")) BETWEEN 1 AND 200),
	CONSTRAINT "digital_assets_file_shape" CHECK(("digital_assets"."kind" = 'file' AND "digital_assets"."filename" IS NOT NULL AND "digital_assets"."media_type" IS NOT NULL) OR ("digital_assets"."kind" = 'licence_keys' AND "digital_assets"."filename" IS NULL AND "digital_assets"."media_type" IS NULL AND "digital_assets"."size_bytes" IS NULL AND "digital_assets"."current_r2_key" IS NULL)),
	CONSTRAINT "digital_assets_ready_file" CHECK("digital_assets"."kind" <> 'file' OR "digital_assets"."status" <> 'ready' OR ("digital_assets"."current_r2_key" IS NOT NULL AND "digital_assets"."size_bytes" IS NOT NULL)),
	CONSTRAINT "digital_assets_r2_key_prefix" CHECK("digital_assets"."current_r2_key" IS NULL OR substr("digital_assets"."current_r2_key", 1, 16) = 'private/digital/'),
	CONSTRAINT "digital_assets_size_range" CHECK("digital_assets"."size_bytes" IS NULL OR "digital_assets"."size_bytes" BETWEEN 0 AND 2147483648),
	CONSTRAINT "digital_assets_download_limit_range" CHECK("digital_assets"."download_limit" IS NULL OR "digital_assets"."download_limit" BETWEEN 1 AND 100),
	CONSTRAINT "digital_assets_access_days_range" CHECK("digital_assets"."access_days" IS NULL OR "digital_assets"."access_days" BETWEEN 1 AND 3650),
	CONSTRAINT "digital_assets_version_positive" CHECK("digital_assets"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `digital_assets_product_status_idx` ON `digital_assets` (`product_id`,`status`);
--> statement-breakpoint
CREATE INDEX `digital_assets_variant_status_idx` ON `digital_assets` (`variant_id`,`status`);
--> statement-breakpoint
CREATE TABLE `digital_asset_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`r2_upload_id` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `digital_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "digital_asset_uploads_status_check" CHECK("digital_asset_uploads"."status" IN ('uploading', 'complete', 'aborted')),
	CONSTRAINT "digital_asset_uploads_r2_key_prefix" CHECK(substr("digital_asset_uploads"."r2_key", 1, 16) = 'private/digital/'),
	CONSTRAINT "digital_asset_uploads_parts_json" CHECK(json_valid("digital_asset_uploads"."parts") AND length("digital_asset_uploads"."parts") <= 20000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digital_asset_uploads_r2_key_unique` ON `digital_asset_uploads` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `digital_asset_uploads_asset_idx` ON `digital_asset_uploads` (`asset_id`);
--> statement-breakpoint
CREATE INDEX `digital_asset_uploads_uploading_idx` ON `digital_asset_uploads` (`status`,`created_at`) WHERE "digital_asset_uploads"."status" = 'uploading';
--> statement-breakpoint
CREATE TABLE `digital_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`fulfillment_id` text,
	`kind` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`download_limit` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`last_download_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `digital_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fulfillment_id`) REFERENCES `order_fulfillments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "digital_entitlements_kind_check" CHECK("digital_entitlements"."kind" IN ('file', 'licence_keys')),
	CONSTRAINT "digital_entitlements_quantity_positive" CHECK("digital_entitlements"."quantity" >= 1),
	CONSTRAINT "digital_entitlements_download_count_bounds" CHECK("digital_entitlements"."download_count" >= 0 AND ("digital_entitlements"."download_limit" IS NULL OR "digital_entitlements"."download_count" <= "digital_entitlements"."download_limit")),
	CONSTRAINT "digital_entitlements_download_limit_range" CHECK("digital_entitlements"."download_limit" IS NULL OR "digital_entitlements"."download_limit" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digital_entitlements_item_asset_unique` ON `digital_entitlements` (`order_item_id`,`asset_id`);
--> statement-breakpoint
CREATE INDEX `digital_entitlements_order_idx` ON `digital_entitlements` (`order_id`);
--> statement-breakpoint
CREATE INDEX `digital_entitlements_asset_idx` ON `digital_entitlements` (`asset_id`);
--> statement-breakpoint
CREATE TABLE `digital_licence_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`key_ciphertext` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_last4` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`order_item_id` text,
	`entitlement_id` text,
	`import_id` text NOT NULL,
	`assigned_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `digital_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`entitlement_id`) REFERENCES `digital_entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "digital_licence_keys_status_check" CHECK("digital_licence_keys"."status" IN ('available', 'assigned', 'revoked')),
	CONSTRAINT "digital_licence_keys_last4_length" CHECK(length("digital_licence_keys"."key_last4") BETWEEN 1 AND 4),
	CONSTRAINT "digital_licence_keys_assignment_shape" CHECK(("digital_licence_keys"."status" = 'assigned' AND "digital_licence_keys"."order_item_id" IS NOT NULL AND "digital_licence_keys"."entitlement_id" IS NOT NULL AND "digital_licence_keys"."assigned_at" IS NOT NULL) OR ("digital_licence_keys"."status" <> 'assigned' AND "digital_licence_keys"."order_item_id" IS NULL AND "digital_licence_keys"."entitlement_id" IS NULL AND "digital_licence_keys"."assigned_at" IS NULL)),
	CONSTRAINT "digital_licence_keys_revoked_shape" CHECK(("digital_licence_keys"."status" = 'revoked' AND "digital_licence_keys"."revoked_at" IS NOT NULL) OR ("digital_licence_keys"."status" <> 'revoked' AND "digital_licence_keys"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digital_licence_keys_asset_hash_unique` ON `digital_licence_keys` (`asset_id`,`key_hash`);
--> statement-breakpoint
CREATE INDEX `digital_licence_keys_pool_idx` ON `digital_licence_keys` (`asset_id`,`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `digital_licence_keys_order_item_idx` ON `digital_licence_keys` (`order_item_id`) WHERE "digital_licence_keys"."order_item_id" IS NOT NULL;
--> statement-breakpoint
-- D2: a key only leaves `available`, once, to `assigned` or `revoked`; every
-- other column is frozen with it.
CREATE TRIGGER `digital_licence_keys_transition`
BEFORE UPDATE ON `digital_licence_keys`
WHEN NOT (OLD.`status` = 'available' AND NEW.`status` IN ('assigned', 'revoked'))
  OR NEW.`id` IS NOT OLD.`id`
  OR NEW.`asset_id` IS NOT OLD.`asset_id`
  OR NEW.`key_ciphertext` IS NOT OLD.`key_ciphertext`
  OR NEW.`key_hash` IS NOT OLD.`key_hash`
  OR NEW.`key_last4` IS NOT OLD.`key_last4`
  OR NEW.`import_id` IS NOT OLD.`import_id`
BEGIN
  SELECT RAISE(ABORT, 'licence keys only move from available to assigned or revoked');
END;
--> statement-breakpoint
CREATE TRIGGER `digital_licence_keys_delete_blocked`
BEFORE DELETE ON `digital_licence_keys`
BEGIN
  SELECT RAISE(ABORT, 'licence keys are durable records, revoke unused keys instead');
END;
--> statement-breakpoint
CREATE INDEX `order_items_auto_pending_idx` ON `order_items` (`order_id`) WHERE "order_items"."fulfillment_type" IN ('digital', 'gift_card') AND "order_items"."fulfilled_quantity" < "order_items"."quantity";
--> statement-breakpoint
CREATE INDEX `product_variants_digital_live_idx` ON `product_variants` (`product_id`) WHERE "product_variants"."fulfillment_kind" = 'digital' AND "product_variants"."deleted_at" IS NULL;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (96, '0096_digital_goods', 'b78be4c196d831cc0fc824fd82c1e66dbc4a9a845b3bef256bde87ee0c5ab718');
