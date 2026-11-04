-- A refund's gift-card settlement, kept once and kept out of the refund's own
-- lines. A refund of an order that bought gift cards settles once, in the
-- batch that ends its last attempt (money refunded + card value kept + units
-- still to issue <= money received):
--   order_withheld_units: units not handed over yet that the refund's money
--     paid for beyond the units it named, so the handover never issues them.
--     The refund's lines (order_refund_lines, unique per refund and line)
--     stay as staff named them. Append-only; `refund_group_id` is the
--     refund's attempt group (one recorded from the provider has no
--     order_refunds record).
--   refund_gift_card_settlements: one row per settled refund, written even
--     when the settlement had nothing else to write; the reconciliation
--     backstop settles a refund that ended without one.
-- Neither is buyer-visible to any cache.
CREATE TABLE `order_withheld_units` (
	`id` text PRIMARY KEY NOT NULL,
	`refund_group_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_withheld_units_quantity_positive" CHECK("order_withheld_units"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_withheld_units_refund_item_unique` ON `order_withheld_units` (`refund_group_id`,`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_withheld_units_order_item_idx` ON `order_withheld_units` (`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_withheld_units_order_idx` ON `order_withheld_units` (`order_id`);
--> statement-breakpoint
CREATE TABLE `refund_gift_card_settlements` (
	`refund_group_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `refund_gift_card_settlements_order_idx` ON `refund_gift_card_settlements` (`order_id`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (193, '0193_withheld_units', '2daaecd645600f5e06090e2d4830af36491a634975aa45febd90f887f9cb1333');
