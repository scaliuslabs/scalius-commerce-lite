-- Line-level facts (COMMERCE-HOOKS H3): fulfilment events list the order lines
-- they handed over, and refunds become records with lines.
--   order_refunds: one row per refund command (its id is the attempts'
--     refund_group_id); status is maintained from its attempts by triggers:
--     pending until each settles, then refunded, failed or partial.
--   order_refund_lines: the order lines a refund is for, append-only, at most
--     each line's quantity across refunds that did not fail.
-- Event triggers (scripts/event-outbox-triggers.ts): order.fulfilled,
-- fulfillment.created and fulfillment.voided gain `lines`; the lines a
-- fulfilment writes after it amend its pending events; refund.created fires
-- on a refund's first attempt and refund.updated on each status change.
-- Existing refunds get a record without lines; pending fulfilment events get
-- their lines. No CASE in any trigger body (remote D1 rule).
CREATE TABLE "order_refunds" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"currency" text COLLATE "C" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"settlement" text COLLATE "C" DEFAULT 'original' NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_refunds_status_check" CHECK("order_refunds"."status" IN ('pending', 'refunded', 'failed', 'partial')),
	CONSTRAINT "order_refunds_settlement_check" CHECK("order_refunds"."settlement" IN ('original', 'store_credit')),
	CONSTRAINT "order_refunds_amount_nonnegative" CHECK("order_refunds"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "order_refunds_order_created_idx" ON "order_refunds" ("order_id","created_at");
--> statement-breakpoint
CREATE TABLE "order_refund_lines" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"refund_id" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"order_item_id" text COLLATE "C" NOT NULL,
	"quantity" bigint NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("refund_id") REFERENCES "order_refunds"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_refund_lines_quantity_positive" CHECK("order_refund_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_refund_lines_refund_item_unique" ON "order_refund_lines" ("refund_id","order_item_id");
--> statement-breakpoint
CREATE INDEX "order_refund_lines_order_item_idx" ON "order_refund_lines" ("order_item_id");
--> statement-breakpoint
CREATE INDEX "order_refund_lines_order_idx" ON "order_refund_lines" ("order_id");
--> statement-breakpoint
INSERT INTO "order_refunds" ("id", "order_id", "status", "currency", "amount_minor", "settlement", "created_at", "updated_at")
SELECT "refund_group_id", min("order_id"),
  CASE
    WHEN sum(CASE WHEN "status" IN ('refunded', 'failed', 'cancelled') THEN 0 ELSE 1 END) > 0 THEN 'pending'
    WHEN sum(CASE WHEN "status" = 'refunded' THEN 1 ELSE 0 END) = count(*) THEN 'refunded'
    WHEN sum(CASE WHEN "status" = 'refunded' THEN 1 ELSE 0 END) = 0 THEN 'failed'
    ELSE 'partial'
  END,
  min("currency"), sum("amount_minor"),
  CASE WHEN sum(CASE WHEN ("metadata"::jsonb ->> 'settlementMode') = 'store_credit' THEN 1 ELSE 0 END) > 0 THEN 'store_credit' ELSE 'original' END,
  min("created_at"), max("updated_at")
FROM "refund_attempts"
GROUP BY "refund_group_id";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refunds_settled_refunded_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM "refund_attempts" AS "sibling" WHERE "sibling"."refund_group_id" = NEW."refund_group_id" AND "sibling"."status" <> 'refunded')), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_refunds" SET "status" = 'refunded', "updated_at" = cast(strftime('%s','now') as bigint) WHERE "id" = NEW."refund_group_id" AND "status" <> 'refunded';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refunds_settled_refunded"
AFTER UPDATE OF "status" ON "refund_attempts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refunds_settled_refunded_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refunds_settled_failed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM "refund_attempts" AS "sibling" WHERE "sibling"."refund_group_id" = NEW."refund_group_id" AND "sibling"."status" NOT IN ('failed', 'cancelled'))), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_refunds" SET "status" = 'failed', "updated_at" = cast(strftime('%s','now') as bigint) WHERE "id" = NEW."refund_group_id" AND "status" <> 'failed';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refunds_settled_failed"
AFTER UPDATE OF "status" ON "refund_attempts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refunds_settled_failed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refunds_settled_partial_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM "refund_attempts" AS "sibling" WHERE "sibling"."refund_group_id" = NEW."refund_group_id" AND "sibling"."status" NOT IN ('refunded', 'failed', 'cancelled'))
  AND EXISTS (SELECT 1 FROM "refund_attempts" AS "sibling" WHERE "sibling"."refund_group_id" = NEW."refund_group_id" AND "sibling"."status" = 'refunded')
  AND EXISTS (SELECT 1 FROM "refund_attempts" AS "sibling" WHERE "sibling"."refund_group_id" = NEW."refund_group_id" AND "sibling"."status" IN ('failed', 'cancelled'))), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_refunds" SET "status" = 'partial', "updated_at" = cast(strftime('%s','now') as bigint) WHERE "id" = NEW."refund_group_id" AND "status" <> 'partial';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refunds_settled_partial"
AFTER UPDATE OF "status" ON "refund_attempts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refunds_settled_partial_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refund_lines_match_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
  SELECT 1 FROM "order_items" AS "item"
  INNER JOIN "order_refunds" AS "refund" ON "refund"."id" = NEW."refund_id"
  WHERE "item"."id" = NEW."order_item_id" AND "item"."order_id" = NEW."order_id" AND "refund"."order_id" = NEW."order_id"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'refund line is not a line of the refund order';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refund_lines_match_insert"
BEFORE INSERT ON "order_refund_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refund_lines_match_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refund_lines_bounds_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (
  SELECT 1 FROM "order_items" AS "item"
  WHERE "item"."id" = NEW."order_item_id"
    AND NEW."quantity" + (
      SELECT coalesce(sum("line"."quantity"), 0) FROM "order_refund_lines" AS "line"
      INNER JOIN "order_refunds" AS "refund" ON "refund"."id" = "line"."refund_id"
      WHERE "line"."order_item_id" = NEW."order_item_id" AND "refund"."status" <> 'failed'
    ) <= "item"."quantity"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'refund exceeds the line quantity';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refund_lines_bounds_insert"
BEFORE INSERT ON "order_refund_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refund_lines_bounds_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_refund_lines_update_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'refund lines are immutable';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "order_refund_lines_update_blocked"
BEFORE UPDATE ON "order_refund_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_refund_lines_update_blocked_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_fulfillments_created" ON "order_fulfillments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_fulfillments_created" ON "order_fulfillments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_fulfillments_voided" ON "order_fulfillments";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.fulfilled', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'fulfillmentId', NEW."id", 'kind', NEW."kind", 'locationId', NEW."location_id", 'lines', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_fulfillment_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."fulfillment_id" = NEW."id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_fulfillments_created"
AFTER INSERT ON "order_fulfillments"
FOR EACH ROW
WHEN (NEW."status" = 'active')
EXECUTE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_fulfillments_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'fulfillment.created', 'fulfillment', NEW."id", jsonb_build_object('fulfillmentId', NEW."id", 'orderId', NEW."order_id", 'kind', NEW."kind", 'locationId', NEW."location_id", 'lines', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_fulfillment_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."fulfillment_id" = NEW."id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_fulfillments_created"
AFTER INSERT ON "order_fulfillments"
FOR EACH ROW
WHEN (NEW."status" = 'active')
EXECUTE FUNCTION scalius_compat."evt_fulfillments_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_fulfillments_voided_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.voided')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'fulfillment.voided', 'fulfillment', NEW."id", jsonb_build_object('fulfillmentId', NEW."id", 'orderId', NEW."order_id", 'kind', NEW."kind", 'locationId', NEW."location_id", 'lines', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_fulfillment_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."fulfillment_id" = NEW."id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_fulfillments_voided"
AFTER UPDATE ON "order_fulfillments"
FOR EACH ROW
WHEN ((OLD."status" = 'active' AND NEW."status" = 'voided'))
EXECUTE FUNCTION scalius_compat."evt_fulfillments_voided_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_refunds_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'refund.*', 'refund.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'refund.created', 'refund', NEW."refund_group_id", jsonb_build_object('refundId', NEW."refund_group_id", 'orderId', NEW."order_id", 'status', (SELECT "status" FROM "order_refunds" WHERE "id" = NEW."refund_group_id"), 'lines', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_refund_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."refund_id" = NEW."refund_group_id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_refunds_created"
AFTER INSERT ON "refund_attempts"
FOR EACH ROW
WHEN (NEW."allocation_index" = 0)
EXECUTE FUNCTION scalius_compat."evt_refunds_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_refunds_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'refund.*', 'refund.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'refund.updated', 'refund', NEW."id", jsonb_build_object('refundId', NEW."id", 'orderId', NEW."order_id", 'previousStatus', OLD."status", 'status', NEW."status", 'lines', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_refund_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."refund_id" = NEW."id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_refunds_updated"
AFTER UPDATE ON "order_refunds"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_refunds_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_fulfillment_lines_facts_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled', 'fulfillment.*', 'fulfillment.created')) THEN
    RETURN NULL;
  END IF;
  UPDATE "event_outbox" SET "data" = jsonb_set("data"::jsonb, '{lines}', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_fulfillment_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."fulfillment_id" = NEW."fulfillment_id" ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text WHERE "resource_type" IN ('order', 'fulfillment') AND "resource_id" IN (NEW."order_id", NEW."fulfillment_id") AND "topic" IN ('order.fulfilled', 'fulfillment.created') AND "status" = 'pending' AND ("data"::jsonb ->> 'fulfillmentId') = NEW."fulfillment_id";
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_fulfillment_lines_facts"
AFTER INSERT ON "order_fulfillment_lines"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_order_fulfillment_lines_facts_fn"();
--> statement-breakpoint
UPDATE "event_outbox" SET "data" = jsonb_set("data"::jsonb, '{lines}', coalesce((SELECT jsonb_agg("line"."fact" ORDER BY "line"."line_order") FROM (SELECT jsonb_build_object('orderItemId', "ledger"."order_item_id", 'variantId', "item"."variant_id", 'quantity', "ledger"."quantity") AS "fact", "ledger"."order_item_id" AS "line_order" FROM "order_fulfillment_lines" AS "ledger" LEFT JOIN "order_items" AS "item" ON "item"."id" = "ledger"."order_item_id" WHERE "ledger"."fulfillment_id" = ("event_outbox"."data"::jsonb ->> 'fulfillmentId') ORDER BY "ledger"."order_item_id" LIMIT 500) AS "line"), '[]'::jsonb))::text
WHERE "topic" IN ('order.fulfilled', 'fulfillment.created', 'fulfillment.voided') AND NOT ("data"::jsonb ? 'lines');
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (172, '0172_line_level_facts', '13db61f89364d479edb68cf5d86a6bc954f4100e201fb254ddf99c6d6cb641a3');