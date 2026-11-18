-- Status CHECKs, the webhook_events claim token and the bulk_runs stall count:
-- see ../0221_queue_claims_and_status_checks.sql. PostgreSQL narrows each CHECK
-- in place; event_outbox keeps the same wider CHECK and guard triggers as
-- SQLite, so an upgraded schema equals a fresh one compiled from the chain.
ALTER TABLE "webhook_event_deliveries" DROP CONSTRAINT IF EXISTS "webhook_event_deliveries_status_check", ADD CONSTRAINT "webhook_event_deliveries_status_check" CHECK("webhook_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "plugin_event_deliveries" DROP CONSTRAINT IF EXISTS "plugin_event_deliveries_status_check", ADD CONSTRAINT "plugin_event_deliveries_status_check" CHECK("plugin_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claim_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT IF EXISTS "webhook_events_status_check", ADD CONSTRAINT "webhook_events_status_check" CHECK("webhook_events"."status" IN ('processing', 'retrying', 'processed', 'failed', 'manual_reconciliation'));
--> statement-breakpoint
ALTER TABLE "bulk_runs" ADD COLUMN "stalls" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT IF EXISTS "notification_outbox_status_check", ADD CONSTRAINT "notification_outbox_status_check" CHECK("notification_outbox"."status" IN ('pending', 'processing', 'sent', 'failed', 'dead_lettered'));
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" DROP CONSTRAINT IF EXISTS "notification_delivery_receipts_status_check", ADD CONSTRAINT "notification_delivery_receipts_status_check" CHECK("notification_delivery_receipts"."status" IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'skipped'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."event_outbox_status_insert_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" NOT IN ('pending', 'processing', 'dispatched', 'failed', 'dead_lettered')), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'event_outbox_status_check';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "event_outbox_status_insert_guard"
BEFORE INSERT ON "event_outbox"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."event_outbox_status_insert_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."event_outbox_status_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" NOT IN ('pending', 'processing', 'dispatched', 'failed', 'dead_lettered')), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'event_outbox_status_check';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "event_outbox_status_update_guard"
BEFORE UPDATE OF "status" ON "event_outbox"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."event_outbox_status_update_guard_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (221, '0221_queue_claims_and_status_checks', 'ff0b23303905005508dcd8922019c1a96a461c3f27c5eefd06bd8733c097ec62');
