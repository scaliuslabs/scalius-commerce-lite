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
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `tax_class_id` text REFERENCES tax_classes(id);--> statement-breakpoint
ALTER TABLE `product_variants` ADD `tax_classification_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `tax_class_id` text REFERENCES tax_classes(id);--> statement-breakpoint
ALTER TABLE `products` ADD `tax_classification_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `unit_price_minor` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `line_subtotal_minor` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `discount_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `taxable_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `tax_amount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `currency_code` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `currency_decimal_places` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `subtotal_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `tax_amount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `total_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `tax_label` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `prices_include_tax` integer DEFAULT false NOT NULL;