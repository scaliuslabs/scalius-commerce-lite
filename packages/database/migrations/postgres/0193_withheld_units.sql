-- A refund's gift-card settlement (see ../0193_withheld_units.sql).
CREATE TABLE "order_withheld_units" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"refund_group_id" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"order_item_id" text COLLATE "C" NOT NULL,
	"quantity" bigint NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_withheld_units_quantity_positive" CHECK("order_withheld_units"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_withheld_units_refund_item_unique" ON "order_withheld_units" ("refund_group_id","order_item_id");
--> statement-breakpoint
CREATE INDEX "order_withheld_units_order_item_idx" ON "order_withheld_units" ("order_item_id");
--> statement-breakpoint
CREATE INDEX "order_withheld_units_order_idx" ON "order_withheld_units" ("order_id");
--> statement-breakpoint
CREATE TABLE "refund_gift_card_settlements" (
	"refund_group_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "refund_gift_card_settlements_order_idx" ON "refund_gift_card_settlements" ("order_id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (193, '0193_withheld_units', '2daaecd645600f5e06090e2d4830af36491a634975aa45febd90f887f9cb1333');
