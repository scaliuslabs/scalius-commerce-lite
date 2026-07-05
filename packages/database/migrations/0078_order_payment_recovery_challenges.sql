CREATE TABLE `order_payment_recovery_challenges` (
  `challenge_key` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `delivery_key` text NOT NULL,
  `method` text NOT NULL,
  `channel` text NOT NULL,
  `identifier_hash` text NOT NULL,
  `identifier_masked` text NOT NULL,
  `code_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `max_attempts` integer NOT NULL DEFAULT 5,
  `resend_available_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer,
  `created_at` integer NOT NULL DEFAULT (cast(strftime('%s','now') as int)),
  `updated_at` integer NOT NULL DEFAULT (cast(strftime('%s','now') as int)),
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_payment_recovery_delivery_key_unique`
ON `order_payment_recovery_challenges` (`delivery_key`);
--> statement-breakpoint
CREATE INDEX `order_payment_recovery_order_status_expires_idx`
ON `order_payment_recovery_challenges` (`order_id`, `status`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `order_payment_recovery_identifier_created_idx`
ON `order_payment_recovery_challenges` (`identifier_hash`, `created_at`);
