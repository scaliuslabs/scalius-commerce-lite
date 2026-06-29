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
CREATE UNIQUE INDEX `meta_capi_purchase_outbox_order_id_unique` ON `meta_capi_purchase_outbox` (`order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `meta_capi_purchase_outbox_event_id_unique` ON `meta_capi_purchase_outbox` (`event_id`);
--> statement-breakpoint
CREATE INDEX `meta_capi_purchase_outbox_pending_idx` ON `meta_capi_purchase_outbox` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `meta_capi_purchase_outbox_claim_idx` ON `meta_capi_purchase_outbox` (`status`,`claim_expires_at`);
