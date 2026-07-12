CREATE TABLE `product_media` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`media_id` text NOT NULL,
	`alt_text` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "product_media_id_valid" CHECK(substr("product_media"."id", 1, 5) = 'pmed_' AND length("product_media"."id") BETWEEN 10 AND 80 AND "product_media"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "product_media_alt_text_valid" CHECK("product_media"."alt_text" IS NULL OR ("product_media"."alt_text" = trim("product_media"."alt_text") AND length("product_media"."alt_text") <= 500)),
	CONSTRAINT "product_media_primary_valid" CHECK("product_media"."is_primary" IN (0, 1)),
	CONSTRAINT "product_media_sort_order_valid" CHECK("product_media"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_media_product_asset_uidx` ON `product_media` (`product_id`,`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_media_product_order_uidx` ON `product_media` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_media_one_primary_uidx` ON `product_media` (`product_id`) WHERE "product_media"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `product_media_product_order_idx` ON `product_media` (`product_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `product_media_asset_product_idx` ON `product_media` (`media_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `product_media_primary_lookup_idx` ON `product_media` (`product_id`,`id`) WHERE "product_media"."is_primary" = 1;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variant_option_values_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variant_option_values_update_guard`;--> statement-breakpoint
CREATE TABLE `__new_product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`option_combination_key` text,
	`image_id` text,
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
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `product_media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "product_variants_option_topology_check" CHECK((
            ("is_default" = true AND "option_combination_key" IS NULL)
            OR
            ("is_default" = false AND trim(coalesce("option_combination_key", '')) <> '')
        ))
);
--> statement-breakpoint
-- Legacy URL rows are not trusted Media assets. Exact SKU image choices are
-- intentionally cleared instead of guessing an association.
INSERT INTO `__new_product_variants`("id", "product_id", "option_combination_key", "image_id", "weight", "sku", "price", "stock", "reserved_stock", "preorder_stock", "is_default", "track_inventory", "version", "stock_version", "low_stock_threshold", "allow_preorder", "preorder_date", "preorder_message", "allow_backorder", "backorder_limit", "tax_class_id", "tax_classification_version", "discount_percentage", "discount_type", "discount_amount", "barcode", "barcode_type", "created_at", "updated_at", "deleted_at") SELECT "id", "product_id", "option_combination_key", NULL, "weight", "sku", "price", "stock", "reserved_stock", "preorder_stock", "is_default", "track_inventory", "version", "stock_version", "low_stock_threshold", "allow_preorder", "preorder_date", "preorder_message", "allow_backorder", "backorder_limit", "tax_class_id", "tax_classification_version", "discount_percentage", "discount_type", "discount_amount", "barcode", "barcode_type", "created_at", "updated_at", "deleted_at" FROM `product_variants`;--> statement-breakpoint
DROP TABLE `product_variants`;--> statement-breakpoint
ALTER TABLE `__new_product_variants` RENAME TO `product_variants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_identity_uidx` ON `product_variants` (lower(trim(`sku`)));--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_barcode_identity_uidx` ON `product_variants` (lower(trim(`barcode`))) WHERE "product_variants"."barcode" IS NOT NULL AND trim("product_variants"."barcode") <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_active_option_identity_uidx` ON `product_variants` (`product_id`,`option_combination_key`) WHERE "product_variants"."deleted_at" IS NULL AND "product_variants"."is_default" = false;--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_one_default_per_product_idx` ON `product_variants` (`product_id`) WHERE `is_default` = true AND `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `product_variants_default_idx` ON `product_variants` (`product_id`,`is_default`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `product_variants_image_idx` ON `product_variants` (`image_id`);--> statement-breakpoint
CREATE INDEX `product_variants_track_inventory_idx` ON `product_variants` (`track_inventory`,`deleted_at`);--> statement-breakpoint
CREATE TRIGGER `product_media_insert_ready_guard`
BEFORE INSERT ON `product_media`
WHEN NOT EXISTS (
	SELECT 1 FROM `media`
	WHERE `id` = NEW.`media_id` AND `status` = 'ready'
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_MEDIA_ASSET');
END;--> statement-breakpoint
CREATE TRIGGER `product_media_identity_update_guard`
BEFORE UPDATE OF `product_id`, `media_id` ON `product_media`
WHEN NEW.`product_id` IS NOT OLD.`product_id`
	OR NEW.`media_id` IS NOT OLD.`media_id`
BEGIN
	SELECT RAISE(ABORT, 'IMMUTABLE_PRODUCT_MEDIA_IDENTITY');
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_identity_insert_guard`
BEFORE INSERT ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
	OR NEW.`sku` <> trim(NEW.`sku`)
	OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
	OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
	OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
	OR (NEW.`image_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1
		FROM `product_media` AS `pm`
		JOIN `media` AS `m` ON `m`.`id` = `pm`.`media_id`
		WHERE `pm`.`id` = NEW.`image_id`
			AND `pm`.`product_id` = NEW.`product_id`
			AND `m`.`kind` = 'image'
			AND `m`.`status` = 'ready'
	))
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_identity_update_guard`
BEFORE UPDATE OF `sku`, `option_combination_key`, `is_default`, `barcode`, `barcode_type`, `image_id`, `product_id` ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
	OR NEW.`sku` <> trim(NEW.`sku`)
	OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
	OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
	OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
	OR (
		NEW.`image_id` IS NOT NULL
		AND (NEW.`image_id` IS NOT OLD.`image_id` OR NEW.`product_id` IS NOT OLD.`product_id`)
		AND NOT EXISTS (
			SELECT 1
			FROM `product_media` AS `pm`
			JOIN `media` AS `m` ON `m`.`id` = `pm`.`media_id`
			WHERE `pm`.`id` = NEW.`image_id`
				AND `pm`.`product_id` = NEW.`product_id`
				AND `m`.`kind` = 'image'
				AND `m`.`status` = 'ready'
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_insert_guard`
BEFORE INSERT ON `product_variant_option_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `product_variants` AS `pv`
	JOIN `product_option_definitions` AS `pod` ON `pod`.`id` = NEW.`option_definition_id`
	JOIN `product_option_values` AS `pov` ON `pov`.`id` = NEW.`option_value_id`
	WHERE `pv`.`id` = NEW.`variant_id`
		AND `pv`.`is_default` = false
		AND `pv`.`product_id` = `pod`.`product_id`
		AND `pov`.`option_definition_id` = `pod`.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_OPTION_ASSIGNMENT');
END;--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_update_guard`
BEFORE UPDATE ON `product_variant_option_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `product_variants` AS `pv`
	JOIN `product_option_definitions` AS `pod` ON `pod`.`id` = NEW.`option_definition_id`
	JOIN `product_option_values` AS `pov` ON `pov`.`id` = NEW.`option_value_id`
	WHERE `pv`.`id` = NEW.`variant_id`
		AND `pv`.`is_default` = false
		AND `pv`.`product_id` = `pod`.`product_id`
		AND `pov`.`option_definition_id` = `pod`.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_OPTION_ASSIGNMENT');
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_after_insert` AFTER INSERT ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_after_update` AFTER UPDATE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_delete` BEFORE DELETE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(`product_variants_fts`, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_update` BEFORE UPDATE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(`product_variants_fts`, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint
INSERT INTO `product_variants_fts`(`product_variants_fts`) VALUES('rebuild');
