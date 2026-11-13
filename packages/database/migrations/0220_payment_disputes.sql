-- Disputes (chargebacks) on captured payments: one row per provider dispute,
-- moved only through the dispute state table
-- (packages/core/src/modules/payments/disputes.ts). `funds = 'withdrawn'`
-- takes `amount_minor` off what the order was paid; the order's payment
-- state sums it with its payment rows (payment-state.ts). Additive: no
-- existing row changes.
CREATE TABLE `payment_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`gateway` text NOT NULL,
	`dispute_ref` text NOT NULL,
	`status` text DEFAULT 'needs_response' NOT NULL,
	`funds` text DEFAULT 'held' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text,
	`evidence_due_at` integer,
	`fee_minor` integer,
	`fee_currency` text,
	`buyer_message` text,
	`dashboard_url` text,
	`recorded_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payment_disputes_status_check" CHECK("payment_disputes"."status" IN ('needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "payment_disputes_funds_check" CHECK("payment_disputes"."funds" IN ('held', 'withdrawn', 'reinstated')),
	CONSTRAINT "payment_disputes_amount_positive" CHECK("payment_disputes"."amount_minor" > 0),
	CONSTRAINT "payment_disputes_fee_nonnegative" CHECK("payment_disputes"."fee_minor" IS NULL OR "payment_disputes"."fee_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_disputes_ref_unique` ON `payment_disputes` (`gateway`,`dispute_ref`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_order_idx` ON `payment_disputes` (`order_id`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_payment_idx` ON `payment_disputes` (`payment_id`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_awaiting_idx` ON `payment_disputes` (`evidence_due_at`) WHERE "payment_disputes"."status" = 'needs_response';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (220, '0220_payment_disputes', '9bb9606a433cf553967f4ca44d8bd9751d085c66e82bfb422d61a4e73e595623');
