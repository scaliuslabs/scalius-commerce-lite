CREATE TABLE `order_support_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL DEFAULT 'submitted',
	`reason` text NOT NULL,
	`message` text,
	`active_key` text,
	`submitted_at` integer NOT NULL DEFAULT (unixepoch()),
	`resolved_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_support_requests_active_key_unique` ON `order_support_requests` (`active_key`);
--> statement-breakpoint
CREATE INDEX `order_support_requests_order_created_idx` ON `order_support_requests` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `order_support_requests_customer_created_idx` ON `order_support_requests` (`customer_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `order_support_requests_status_created_idx` ON `order_support_requests` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `order_support_requests_type_status_idx` ON `order_support_requests` (`type`,`status`);
--> statement-breakpoint
CREATE TABLE `order_support_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`note` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`request_id`) REFERENCES `order_support_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_support_request_events_request_created_idx` ON `order_support_request_events` (`request_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `order_support_request_events_order_created_idx` ON `order_support_request_events` (`order_id`,`created_at`);
