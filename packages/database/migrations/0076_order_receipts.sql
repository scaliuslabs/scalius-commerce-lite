CREATE TABLE `order_receipts` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `source` text NOT NULL DEFAULT 'checkout',
  `status` text NOT NULL DEFAULT 'active',
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL DEFAULT (cast(strftime('%s','now') as int)),
  `updated_at` integer NOT NULL DEFAULT (cast(strftime('%s','now') as int)),
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_receipts_order_id_idx`
ON `order_receipts` (`order_id`);
--> statement-breakpoint
CREATE INDEX `order_receipts_status_expires_idx`
ON `order_receipts` (`status`, `expires_at`);
