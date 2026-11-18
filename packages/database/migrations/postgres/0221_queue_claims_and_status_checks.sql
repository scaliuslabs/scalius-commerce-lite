-- See ../0221_queue_claims_and_status_checks.sql. PostgreSQL adds the guards
-- as CHECKs in place, after the same mapping of retired states; the schema
-- compiler turns the SQLite guard triggers into these CHECKs, so a fresh
-- schema equals an upgraded one.
ALTER TABLE "webhook_events" ADD COLUMN "claim_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "bulk_runs" ADD COLUMN "stalls" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "event_outbox" SET "status" = 'pending', "claim_id" = NULL, "claim_expires_at" = NULL, "next_attempt_at" = unixepoch() WHERE "status" IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE "webhook_event_deliveries" SET "status" = 'pending', "claim_id" = NULL, "claim_expires_at" = NULL, "next_attempt_at" = unixepoch() WHERE "status" IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE "plugin_event_deliveries" SET "status" = 'pending', "claim_id" = NULL, "claim_expires_at" = NULL, "next_attempt_at" = unixepoch() WHERE "status" IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE "notification_outbox" SET "status" = 'pending', "claim_id" = NULL, "claim_expires_at" = NULL, "next_attempt_at" = unixepoch() WHERE "status" IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE "webhook_events" SET "status" = 'failed' WHERE "status" IN ('queued');
--> statement-breakpoint
ALTER TABLE "event_outbox" DROP CONSTRAINT IF EXISTS "event_outbox_status_check", ADD CONSTRAINT "event_outbox_status_check" CHECK("event_outbox"."status" IN ('pending', 'processing', 'dispatched', 'failed', 'dead_lettered'));
--> statement-breakpoint
ALTER TABLE "webhook_event_deliveries" DROP CONSTRAINT IF EXISTS "webhook_event_deliveries_status_check", ADD CONSTRAINT "webhook_event_deliveries_status_check" CHECK("webhook_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "plugin_event_deliveries" DROP CONSTRAINT IF EXISTS "plugin_event_deliveries_status_check", ADD CONSTRAINT "plugin_event_deliveries_status_check" CHECK("plugin_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT IF EXISTS "notification_outbox_status_check", ADD CONSTRAINT "notification_outbox_status_check" CHECK("notification_outbox"."status" IN ('pending', 'processing', 'sent', 'failed', 'dead_lettered'));
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" DROP CONSTRAINT IF EXISTS "notification_delivery_receipts_status_check", ADD CONSTRAINT "notification_delivery_receipts_status_check" CHECK("notification_delivery_receipts"."status" IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'skipped'));
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT IF EXISTS "webhook_events_status_check", ADD CONSTRAINT "webhook_events_status_check" CHECK("webhook_events"."status" IN ('processing', 'retrying', 'processed', 'failed', 'manual_reconciliation'));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (221, '0221_queue_claims_and_status_checks', '95800d5f9ef506ddf20f1ede7357f730502d3c9872254b607bbdce7bbf675e40');
