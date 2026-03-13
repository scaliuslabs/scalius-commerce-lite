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
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inventory_movements_variant_idx` ON `inventory_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_created_at_idx` ON `inventory_movements` (`created_at`);--> statement-breakpoint
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
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_low_stock_alerts_variant_id_unique` ON `product_low_stock_alerts` (`variant_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_product_idx` ON `product_low_stock_alerts` (`product_id`);--> statement-breakpoint
CREATE INDEX `pls_alerts_status_idx` ON `product_low_stock_alerts` (`alert_status`);--> statement-breakpoint
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
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `delivery_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_delivery_shipments`("id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at") SELECT "id", "order_id", "provider_id", "provider_type", "external_id", "tracking_id", "tracking_url", "courier_name", "status", "raw_status", "note", "metadata", "last_checked", "shipment_items", "shipment_amount", "is_final_shipment", "created_at", "updated_at" FROM `delivery_shipments`;--> statement-breakpoint
DROP TABLE `delivery_shipments`;--> statement-breakpoint
ALTER TABLE `__new_delivery_shipments` RENAME TO `delivery_shipments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `order_items` ADD `product_name` text;--> statement-breakpoint
ALTER TABLE `order_items` ADD `variant_label` text;--> statement-breakpoint
ALTER TABLE `order_items` ADD `fulfillment_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_method` text DEFAULT 'cod' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_status` text DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `paid_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `balance_due` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `fulfillment_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `inventory_pool` text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `expected_delivery` text;--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_payment_status_idx` ON `orders` (`payment_status`);--> statement-breakpoint
CREATE INDEX `orders_customer_id_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_created_at_idx` ON `orders` (`created_at`);--> statement-breakpoint
ALTER TABLE `product_variants` ADD `reserved_stock` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `preorder_stock` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `low_stock_threshold` integer;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `allow_preorder` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `preorder_date` text;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `preorder_message` text;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `allow_backorder` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `backorder_limit` integer DEFAULT 0 NOT NULL;