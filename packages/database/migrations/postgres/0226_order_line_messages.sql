-- A delivery message on an order line: see ../0226_order_line_messages.sql.
CREATE TABLE "order_line_messages" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"order_item_id" text COLLATE "C" NOT NULL,
	"body_ciphertext" text COLLATE "C",
	"has_link" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"removed_at" bigint,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_line_messages_id_shape" CHECK(substr("order_line_messages"."id", 1, 4) = 'olm_' AND length("order_line_messages"."id") BETWEEN 8 AND 64),
	CONSTRAINT "order_line_messages_body_shape" CHECK(("order_line_messages"."removed_at" IS NULL) = ("order_line_messages"."body_ciphertext" IS NOT NULL) AND ("order_line_messages"."body_ciphertext" IS NULL OR (substr("order_line_messages"."body_ciphertext", 1, 3) = 'v1:' AND length("order_line_messages"."body_ciphertext") <= 24576)) AND ("order_line_messages"."removed_at" IS NULL OR "order_line_messages"."has_link" = 0)),
	CONSTRAINT "order_line_messages_has_link_bool" CHECK("order_line_messages"."has_link" IN (0, 1)),
	CONSTRAINT "order_line_messages_revision_positive" CHECK("order_line_messages"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_messages_item_unique" ON "order_line_messages" ("order_item_id");
--> statement-breakpoint
CREATE INDEX "order_line_messages_order_idx" ON "order_line_messages" ("order_id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (226, '0226_order_line_messages', 'ab7145b5fbbfc7bf2aaa4f7468da3f21b0bc1ff3ba31823884476d70451b2820');
