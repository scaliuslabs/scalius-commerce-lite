PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`total_amount_minor` integer DEFAULT 0 NOT NULL,
	`deposit_amount_minor` integer DEFAULT 0 NOT NULL,
	`balance_due_minor` integer DEFAULT 0 NOT NULL,
	`deposit_paid_at` integer,
	`balance_paid_at` integer,
	`balance_due_date` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`kind` text DEFAULT 'online' NOT NULL,
	`instructions` text,
	`percent` integer,
	`contact_snapshot` text,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payment_plans_kind_check" CHECK("__new_payment_plans"."kind" IN ('online', 'manual')),
	CONSTRAINT "payment_plans_percent_range" CHECK(("__new_payment_plans"."percent" IS NULL) OR ("__new_payment_plans"."percent" BETWEEN 1 AND 99))
);
--> statement-breakpoint
INSERT INTO `__new_payment_plans`("id", "order_id", "total_amount_minor", "deposit_amount_minor", "balance_due_minor", "deposit_paid_at", "balance_paid_at", "balance_due_date", "status", "created_at", "updated_at") SELECT "id", "order_id", "total_amount_minor", "deposit_amount_minor", "balance_due_minor", "deposit_paid_at", "balance_paid_at", "balance_due_date", "status", "created_at", "updated_at" FROM `payment_plans`;--> statement-breakpoint
DROP TABLE `payment_plans`;--> statement-breakpoint
ALTER TABLE `__new_payment_plans` RENAME TO `payment_plans`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_plans_order_id_unique` ON `payment_plans` (`order_id`);