-- A delivery message on an order line (rules/orders/buyer-line-delivery-message.md):
-- what staff write for the buyer of one line (an account's sign-in, an
-- instruction, an optional https link), sealed like a licence key
-- (`v1:<iv>:<sealed>`, AES-256-GCM under a key derived from
-- CREDENTIAL_ENCRYPTION_KEY) and read only by the order's signed-in buyer.
-- Additive: one new table, no rebuild, no backfill, no trigger. Its rows
-- follow their order and line (ON DELETE CASCADE); removing a message nulls
-- the ciphertext and keeps the row, so its revision never repeats.
CREATE TABLE `order_line_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`body_ciphertext` text,
	`has_link` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_line_messages_id_shape" CHECK(substr("order_line_messages"."id", 1, 4) = 'olm_' AND length("order_line_messages"."id") BETWEEN 8 AND 64),
	CONSTRAINT "order_line_messages_body_shape" CHECK(("order_line_messages"."removed_at" IS NULL) = ("order_line_messages"."body_ciphertext" IS NOT NULL) AND ("order_line_messages"."body_ciphertext" IS NULL OR (substr("order_line_messages"."body_ciphertext", 1, 3) = 'v1:' AND length("order_line_messages"."body_ciphertext") <= 24576)) AND ("order_line_messages"."removed_at" IS NULL OR "order_line_messages"."has_link" = 0)),
	CONSTRAINT "order_line_messages_has_link_bool" CHECK("order_line_messages"."has_link" IN (0, 1)),
	CONSTRAINT "order_line_messages_revision_positive" CHECK("order_line_messages"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_messages_item_unique` ON `order_line_messages` (`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_line_messages_order_idx` ON `order_line_messages` (`order_id`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (226, '0226_order_line_messages', 'ab7145b5fbbfc7bf2aaa4f7468da3f21b0bc1ff3ba31823884476d70451b2820');
