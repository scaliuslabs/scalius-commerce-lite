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
CREATE INDEX `order_notification_outbox_order_id_idx` ON `order_notification_outbox` (`order_id`);