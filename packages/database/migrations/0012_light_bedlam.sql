CREATE TABLE `inventory_operations` (
	`operation_key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`operation_type` text NOT NULL,
	`variant_id` text NOT NULL,
	`movement_id` text,
	`result_payload` text NOT NULL,
	`stock_version_before` integer NOT NULL,
	`stock_version_after` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `inventory_operations_variant_created_idx` ON `inventory_operations` (`variant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_operations_movement_idx` ON `inventory_operations` (`movement_id`);