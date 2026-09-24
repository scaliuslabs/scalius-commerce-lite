-- Sequential order numbers (#1001…), the staff order timeline, failed-delivery
-- notes, per-line shipped quantities, and a separate "partially refunded"
-- payment state (a refund no longer rewrites the order lifecycle status).
ALTER TABLE "orders" ADD COLUMN "order_number" integer;
--> statement-breakpoint
UPDATE "orders" SET "order_number" = 1000 + ranked."position"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "position" FROM "orders"
) AS ranked
WHERE ranked."id" = "orders"."id";
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_unique" ON "orders" ("order_number");
--> statement-breakpoint
UPDATE "orders" SET "status" = 'delivered', "payment_status" = 'partially_refunded', "balance_due_minor" = 0
WHERE "status" = 'partially_refunded';
--> statement-breakpoint
UPDATE "orders" SET "payment_status" = 'partially_refunded', "balance_due_minor" = 0
WHERE "payment_status" = 'partial' AND EXISTS (
  SELECT 1 FROM "order_payments"
  WHERE "order_payments"."order_id" = "orders"."id"
    AND "order_payments"."payment_type" = 'refund'
    AND "order_payments"."status" = 'refunded'
);
--> statement-breakpoint
ALTER TABLE "cod_tracking" ADD COLUMN "failure_note" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "shipped_quantity" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "order_items" SET "shipped_quantity" = "quantity" WHERE "fulfillment_status" IN ('shipped', 'delivered');
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"data" text,
	"actor_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "order_events_order_created_idx" ON "order_events" ("order_id", "created_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (70, '0070_order_numbers_timeline', 'c25a4602a4cd7bbb42a7d3b8e539c30b553d26c0614cf61395df84ddaf3d6b89');
