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
CREATE UNIQUE INDEX `checkout_attempts_request_key_unique` ON `checkout_attempts` (`request_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_checkout_token_unique` ON `checkout_attempts` (`checkout_token`);
--> statement-breakpoint
CREATE INDEX `checkout_attempts_order_id_idx` ON `checkout_attempts` (`order_id`);
--> statement-breakpoint
CREATE INDEX `checkout_attempts_status_claim_idx` ON `checkout_attempts` (`status`,`claim_expires_at`);
