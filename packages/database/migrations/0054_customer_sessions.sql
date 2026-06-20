CREATE TABLE `customer_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `customer_id` text NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  `created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  `updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_sessions_customer_id_idx`
  ON `customer_sessions` (`customer_id`);
--> statement-breakpoint
CREATE INDEX `customer_sessions_active_expiry_idx`
  ON `customer_sessions` (`revoked_at`, `expires_at`);
