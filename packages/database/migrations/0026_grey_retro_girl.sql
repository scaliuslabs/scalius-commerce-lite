PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`revision` integer DEFAULT 1 NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "discounts_revision_positive" CHECK("revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_discounts`("id", "code", "type", "value_type", "discount_value", "min_purchase_amount", "min_quantity", "max_uses_per_order", "max_uses", "limit_one_per_customer", "combine_with_product_discounts", "combine_with_order_discounts", "combine_with_shipping_discounts", "customer_segment", "revision", "start_date", "end_date", "is_active", "created_at", "updated_at", "deleted_at") SELECT "id", "code", "type", "value_type", "discount_value", "min_purchase_amount", "min_quantity", "max_uses_per_order", "max_uses", "limit_one_per_customer", "combine_with_product_discounts", "combine_with_order_discounts", "combine_with_shipping_discounts", "customer_segment", 1, "start_date", "end_date", "is_active", "created_at", "updated_at", "deleted_at" FROM `discounts`;--> statement-breakpoint
DROP TABLE `discounts`;--> statement-breakpoint
ALTER TABLE `__new_discounts` RENAME TO `discounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `discounts_code_unique_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE INDEX `discounts_deleted_at_idx` ON `discounts` (`deleted_at`);
