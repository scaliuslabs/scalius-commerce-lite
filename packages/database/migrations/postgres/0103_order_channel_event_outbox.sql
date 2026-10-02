-- Order channel and event outbox (COMMERCE-HOOKS H2, H3).
-- H2: orders.channel (NOT NULL, the creating surface) and orders.channel_source
-- (a merchant label slug). H3: event_outbox rows written by triggers in the
-- same transaction as the domain write, webhook subscriptions (signing secret
-- encrypted under CREDENTIAL_ENCRYPTION_KEY) and the bounded delivery log
-- (webhook_event_deliveries; webhook_deliveries is a retired legacy name).
-- No backward compatibility: existing orders are backfilled below.
CREATE TABLE "event_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"data" text NOT NULL,
	"occurred_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text,
	"claim_expires_at" bigint,
	"last_error" text,
	"queued_at" bigint,
	"dispatched_at" bigint,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "event_outbox_status_check" CHECK("event_outbox"."status" IN ('pending', 'enqueueing', 'queued', 'processing', 'dispatched', 'failed', 'dead_lettered')),
	CONSTRAINT "event_outbox_data_json" CHECK(json_valid("event_outbox"."data"))
);
--> statement-breakpoint
CREATE INDEX "event_outbox_due_idx" ON "event_outbox" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "event_outbox_claim_idx" ON "event_outbox" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "event_outbox_queued_idx" ON "event_outbox" ("status","queued_at");
--> statement-breakpoint
CREATE INDEX "event_outbox_resource_idx" ON "event_outbox" ("resource_type","resource_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "event_outbox_topic_idx" ON "event_outbox" ("topic","occurred_at");
--> statement-breakpoint
CREATE INDEX "event_outbox_occurred_idx" ON "event_outbox" ("occurred_at");
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"topics" text NOT NULL,
	"api_version" text NOT NULL,
	"description" text,
	"secret_ciphertext" text NOT NULL,
	"secret_hint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"disabled_at" bigint,
	"failure_streak" bigint DEFAULT 0 NOT NULL,
	"failing_since" bigint,
	"last_success_at" bigint,
	"last_failure_at" bigint,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("created_by") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "webhook_subscriptions_status_check" CHECK("webhook_subscriptions"."status" IN ('active', 'disabled')),
	CONSTRAINT "webhook_subscriptions_disabled_shape" CHECK(("webhook_subscriptions"."status" = 'active' AND "webhook_subscriptions"."disabled_reason" IS NULL AND "webhook_subscriptions"."disabled_at" IS NULL) OR ("webhook_subscriptions"."status" = 'disabled' AND "webhook_subscriptions"."disabled_reason" IN ('manual', 'failing') AND "webhook_subscriptions"."disabled_at" IS NOT NULL)),
	CONSTRAINT "webhook_subscriptions_url_length" CHECK(length("webhook_subscriptions"."url") BETWEEN 9 AND 2048 AND substr("webhook_subscriptions"."url", 1, 8) = 'https://'),
	CONSTRAINT "webhook_subscriptions_topics_json" CHECK(json_valid("webhook_subscriptions"."topics") AND substr("webhook_subscriptions"."topics", 1, 1) = '['),
	CONSTRAINT "webhook_subscriptions_description_length" CHECK("webhook_subscriptions"."description" IS NULL OR length("webhook_subscriptions"."description") <= 200),
	CONSTRAINT "webhook_subscriptions_failure_streak_nonnegative" CHECK("webhook_subscriptions"."failure_streak" >= 0),
	CONSTRAINT "webhook_subscriptions_version_positive" CHECK("webhook_subscriptions"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_status_idx" ON "webhook_subscriptions" ("status","created_at");
--> statement-breakpoint
CREATE TABLE "webhook_event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"event_id" text,
	"kind" text DEFAULT 'event' NOT NULL,
	"topic" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text,
	"claim_expires_at" bigint,
	"queued_at" bigint,
	"last_attempt_at" bigint,
	"response_status" bigint,
	"duration_ms" bigint,
	"response_excerpt" text,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("event_id") REFERENCES "event_outbox"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "webhook_event_deliveries_kind_check" CHECK("webhook_event_deliveries"."kind" IN ('event', 'test')),
	CONSTRAINT "webhook_event_deliveries_status_check" CHECK("webhook_event_deliveries"."status" IN ('pending', 'enqueueing', 'queued', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')),
	CONSTRAINT "webhook_event_deliveries_excerpt_length" CHECK("webhook_event_deliveries"."response_excerpt" IS NULL OR length("webhook_event_deliveries"."response_excerpt") <= 256),
	CONSTRAINT "webhook_event_deliveries_error_length" CHECK("webhook_event_deliveries"."last_error" IS NULL OR length("webhook_event_deliveries"."last_error") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_deliveries_subscription_event_unique" ON "webhook_event_deliveries" ("subscription_id","event_id") WHERE "webhook_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_due_idx" ON "webhook_event_deliveries" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_claim_idx" ON "webhook_event_deliveries" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_queued_idx" ON "webhook_event_deliveries" ("status","queued_at");
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_subscription_created_idx" ON "webhook_event_deliveries" ("subscription_id","created_at");
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_event_idx" ON "webhook_event_deliveries" ("event_id") WHERE "webhook_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "webhook_event_deliveries_created_idx" ON "webhook_event_deliveries" ("created_at");
--> statement-breakpoint
-- Theme preview sessions store no theme (dashboard theme workflow schema
-- change, generated with this migration). Nothing references the table.
ALTER TABLE "theme_preview_sessions" DROP COLUMN "theme", DROP COLUMN "draft_revision", DROP COLUMN "base_published_revision";
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel" text DEFAULT 'online_store' NOT NULL CONSTRAINT "orders_channel_check" CHECK ("channel" IN ('online_store', 'admin', 'pos', 'agent', 'app'));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel_source" text CONSTRAINT "orders_channel_source_shape" CHECK ("channel_source" IS NULL OR (length("channel_source") BETWEEN 1 AND 64 AND "channel_source" = lower(trim("channel_source"))));
--> statement-breakpoint
CREATE INDEX "orders_channel_list_idx" ON "orders" ("deleted_at","channel","updated_at");
--> statement-breakpoint
-- >>> H2H3 order channel and event outbox: triggers and backfill
-- H2 backfill: an order with a dashboard create attempt came from the
-- dashboard; one an agent storefront context created came from an agent;
-- every other order came through the storefront checkout (the default).
UPDATE "orders" SET "channel" = 'admin'
WHERE EXISTS (SELECT 1 FROM "admin_order_create_attempts" AS a WHERE a."order_id" = "orders"."id");
--> statement-breakpoint
UPDATE "orders" SET "channel" = 'agent'
WHERE EXISTS (SELECT 1 FROM "agent_storefront_order_grants" AS g WHERE g."order_id" = "orders"."id" AND g."authority_kind" = 'created');
--> statement-breakpoint
-- The channel is a fact of creation.
CREATE OR REPLACE FUNCTION scalius_compat."orders_channel_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."channel" IS DISTINCT FROM OLD."channel"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order channel is immutable';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "orders_channel_immutable"
BEFORE UPDATE OF "channel" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."orders_channel_immutable_fn"();
--> statement-breakpoint
-- H3: one event_outbox row per domain fact, in the writer's transaction.
-- Generated by packages/database/scripts/event-outbox-triggers.ts; every guard
-- is in WHEN and every body is one INSERT.
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.created', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'status', NEW."status", 'paymentStatus', NEW."payment_status", 'channel', NEW."channel")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_created"
AFTER INSERT ON "orders"
FOR EACH ROW
WHEN (NEW."status" <> 'incomplete')
EXECUTE FUNCTION scalius_compat."evt_orders_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_created_from_incomplete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.created', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'status', NEW."status", 'paymentStatus', NEW."payment_status", 'channel', NEW."channel")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_created_from_incomplete"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((OLD."status" = 'incomplete' AND NEW."status" NOT IN ('incomplete', 'cancelled')))
EXECUTE FUNCTION scalius_compat."evt_orders_created_from_incomplete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.updated', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status", 'previousPaymentStatus', OLD."payment_status", 'paymentStatus', NEW."payment_status", 'previousFulfillmentStatus', OLD."fulfillment_status", 'fulfillmentStatus', NEW."fulfillment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_updated"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((OLD."status" <> 'incomplete' AND NEW."status" <> 'incomplete' AND (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."payment_status" IS DISTINCT FROM NEW."payment_status" OR OLD."fulfillment_status" IS DISTINCT FROM NEW."fulfillment_status" OR OLD."payment_method" IS DISTINCT FROM NEW."payment_method" OR OLD."paid_amount_minor" IS DISTINCT FROM NEW."paid_amount_minor" OR OLD."balance_due_minor" IS DISTINCT FROM NEW."balance_due_minor" OR OLD."subtotal_amount_minor" IS DISTINCT FROM NEW."subtotal_amount_minor" OR OLD."shipping_amount_minor" IS DISTINCT FROM NEW."shipping_amount_minor" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."tax_amount_minor" IS DISTINCT FROM NEW."tax_amount_minor" OR OLD."total_amount_minor" IS DISTINCT FROM NEW."total_amount_minor" OR OLD."customer_name" IS DISTINCT FROM NEW."customer_name" OR OLD."customer_phone" IS DISTINCT FROM NEW."customer_phone" OR OLD."customer_email" IS DISTINCT FROM NEW."customer_email" OR OLD."customer_whatsapp" IS DISTINCT FROM NEW."customer_whatsapp" OR OLD."shipping_address" IS DISTINCT FROM NEW."shipping_address" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."notes" IS DISTINCT FROM NEW."notes" OR OLD."shipping_method_id" IS DISTINCT FROM NEW."shipping_method_id" OR OLD."pickup_ready_at" IS DISTINCT FROM NEW."pickup_ready_at" OR OLD."expected_delivery" IS DISTINCT FROM NEW."expected_delivery" OR OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."channel_source" IS DISTINCT FROM NEW."channel_source" OR OLD."invoice_number" IS DISTINCT FROM NEW."invoice_number" OR OLD."archived_at" IS DISTINCT FROM NEW."archived_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at")))
EXECUTE FUNCTION scalius_compat."evt_orders_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_paid_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.paid', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousPaymentStatus', NULL, 'paymentStatus', NEW."payment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_paid_insert"
AFTER INSERT ON "orders"
FOR EACH ROW
WHEN ((NEW."payment_status" = 'paid' AND NEW."status" <> 'incomplete'))
EXECUTE FUNCTION scalius_compat."evt_orders_paid_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_paid_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.paid', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousPaymentStatus', OLD."payment_status", 'paymentStatus', NEW."payment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_paid"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((NEW."payment_status" = 'paid' AND OLD."payment_status" IS DISTINCT FROM 'paid' AND NEW."status" <> 'incomplete'))
EXECUTE FUNCTION scalius_compat."evt_orders_paid_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_cancelled_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.cancelled', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousStatus', OLD."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_cancelled"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((NEW."status" = 'cancelled' AND OLD."status" NOT IN ('cancelled', 'incomplete')))
EXECUTE FUNCTION scalius_compat."evt_orders_cancelled_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.fulfilled', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'fulfillmentId', NEW."id", 'kind', NEW."kind", 'locationId', NEW."location_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_fulfillments_created"
AFTER INSERT ON "order_fulfillments"
FOR EACH ROW
WHEN (NEW."status" = 'active')
EXECUTE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_payments_refunded_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.refunded', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'paymentId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_payments_refunded_insert"
AFTER INSERT ON "order_payments"
FOR EACH ROW
WHEN ((NEW."payment_type" = 'refund' AND NEW."status" = 'refunded'))
EXECUTE FUNCTION scalius_compat."evt_order_payments_refunded_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_payments_refunded_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.refunded', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'paymentId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_payments_refunded"
AFTER UPDATE ON "order_payments"
FOR EACH ROW
WHEN ((NEW."payment_type" = 'refund' AND NEW."status" = 'refunded' AND OLD."status" IS DISTINCT FROM 'refunded'))
EXECUTE FUNCTION scalius_compat."evt_order_payments_refunded_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_returns_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'return.updated', 'return', NEW."id", jsonb_build_object('returnId', NEW."id", 'orderId', NEW."order_id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_returns_created"
AFTER INSERT ON "order_returns"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_order_returns_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_returns_status_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'return.updated', 'return', NEW."id", jsonb_build_object('returnId', NEW."id", 'orderId', NEW."order_id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_returns_status"
AFTER UPDATE ON "order_returns"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_order_returns_status_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.created', 'product', NEW."id", jsonb_build_object('productId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_created"
AFTER INSERT ON "products"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_products_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.updated', 'product', NEW."id", jsonb_build_object('productId', NEW."id", 'revision', NEW."aggregate_revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_updated"
AFTER UPDATE ON "products"
FOR EACH ROW
WHEN ((NEW."deleted_at" IS NULL AND ((OLD."aggregate_revision" IS DISTINCT FROM NEW."aggregate_revision" OR OLD."tax_classification_version" IS DISTINCT FROM NEW."tax_classification_version") OR OLD."deleted_at" IS NOT NULL)))
EXECUTE FUNCTION scalius_compat."evt_products_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_trashed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.deleted', 'product', NEW."id", jsonb_build_object('productId', NEW."id", 'deletion', 'trashed')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_trashed"
AFTER UPDATE ON "products"
FOR EACH ROW
WHEN ((OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_products_trashed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.deleted', 'product', OLD."id", jsonb_build_object('productId', OLD."id", 'deletion', 'permanent')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_deleted"
AFTER DELETE ON "products"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_products_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_movements_stock_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.level_changed', 'variant', NEW."variant_id", jsonb_build_object('variantId', NEW."variant_id", 'productId', (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."variant_id"), 'locationId', NEW."location_id", 'quantityDelta', NEW."stock_delta", 'movementId', NEW."id", 'movementType', NEW."type")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_movements_stock"
AFTER INSERT ON "inventory_movements"
FOR EACH ROW
WHEN (NEW."stock_delta" <> 0)
EXECUTE FUNCTION scalius_compat."evt_inventory_movements_stock_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_movements_reverted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.level_changed', 'variant', OLD."variant_id", jsonb_build_object('variantId', OLD."variant_id", 'productId', (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."variant_id"), 'locationId', OLD."location_id", 'quantityDelta', -OLD."stock_delta", 'movementId', OLD."id", 'movementType', 'reversal')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_movements_reverted"
AFTER DELETE ON "inventory_movements"
FOR EACH ROW
WHEN (OLD."stock_delta" <> 0)
EXECUTE FUNCTION scalius_compat."evt_inventory_movements_reverted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.created', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_created"
AFTER INSERT ON "customers"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customers_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_updated"
AFTER UPDATE ON "customers"
FOR EACH ROW
WHEN ((OLD."name" IS DISTINCT FROM NEW."name" OR OLD."email" IS DISTINCT FROM NEW."email" OR OLD."phone" IS DISTINCT FROM NEW."phone" OR OLD."address" IS DISTINCT FROM NEW."address" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."city_name" IS DISTINCT FROM NEW."city_name" OR OLD."zone_name" IS DISTINCT FROM NEW."zone_name" OR OLD."area_name" IS DISTINCT FROM NEW."area_name" OR OLD."account_claimed_at" IS DISTINCT FROM NEW."account_claimed_at" OR OLD."phone_verified_at" IS DISTINCT FROM NEW."phone_verified_at" OR OLD."email_verified_at" IS DISTINCT FROM NEW."email_verified_at" OR OLD."origin" IS DISTINCT FROM NEW."origin" OR OLD."merged_into_customer_id" IS DISTINCT FROM NEW."merged_into_customer_id" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"))
EXECUTE FUNCTION scalius_compat."evt_customers_updated_fn"();
-- <<< H2H3
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (103, '0103_order_channel_event_outbox', 'aea0cc76afe248d854897da514a934d53b9aca0c2c5f1753b6902cd136c9d14b');
