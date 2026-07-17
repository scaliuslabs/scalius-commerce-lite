CREATE TABLE `admin_order_create_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`request_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`order_id` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`response_payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_order_create_attempts_key_unique` ON `admin_order_create_attempts` (`request_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `admin_order_create_attempts_order_unique` ON `admin_order_create_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `admin_order_create_attempts_status_claim_idx` ON `admin_order_create_attempts` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `admin_order_create_attempts_actor_created_idx` ON `admin_order_create_attempts` (`actor_id`,`created_at`);