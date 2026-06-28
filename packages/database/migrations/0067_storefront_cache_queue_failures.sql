CREATE TABLE `storefront_cache_queue_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_name` text NOT NULL,
	`queue_message_id` text NOT NULL,
	`message_type` text NOT NULL,
	`operation_id` text,
	`source` text,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`message_timestamp` integer,
	`failed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`replayed_at` integer,
	`replayed_by` text,
	`ignored_at` integer,
	`ignored_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storefront_cache_queue_failures_message_unique` ON `storefront_cache_queue_failures` (`queue_message_id`);
--> statement-breakpoint
CREATE INDEX `storefront_cache_queue_failures_status_failed_idx` ON `storefront_cache_queue_failures` (`status`, `failed_at`);
--> statement-breakpoint
CREATE INDEX `storefront_cache_queue_failures_operation_idx` ON `storefront_cache_queue_failures` (`operation_id`);
