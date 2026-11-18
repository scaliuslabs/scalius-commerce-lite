-- The queue tables refuse any status their code does not declare
-- (packages/database/src/status-guards.ts, which generates the statements
-- below), webhook_events gains its claim token and bulk_runs its stall count.
-- No table is rebuilt. First the states 0148 retired are mapped again, the
-- same idempotent way 0148 did, in case the old Worker wrote one after 0148
-- ran: only rows that hold one are written. Then each table gets two guard
-- triggers (insert, status change) that write no row; existing rows are left
-- as they are. PostgreSQL gets CHECKs instead (postgres/0221).
ALTER TABLE `webhook_events` ADD `claim_id` text;
--> statement-breakpoint
ALTER TABLE `bulk_runs` ADD `stalls` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `event_outbox` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `webhook_event_deliveries` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `plugin_event_deliveries` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `notification_outbox` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `webhook_events` SET `status` = 'failed' WHERE `status` IN ('queued');
--> statement-breakpoint
CREATE TRIGGER `event_outbox_status_insert_guard`
BEFORE INSERT ON `event_outbox`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'dispatched', 'failed', 'dead_lettered')
BEGIN
  SELECT RAISE(ABORT, 'event_outbox_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `event_outbox_status_update_guard`
BEFORE UPDATE OF `status` ON `event_outbox`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'dispatched', 'failed', 'dead_lettered')
BEGIN
  SELECT RAISE(ABORT, 'event_outbox_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `webhook_event_deliveries_status_insert_guard`
BEFORE INSERT ON `webhook_event_deliveries`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'webhook_event_deliveries_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `webhook_event_deliveries_status_update_guard`
BEFORE UPDATE OF `status` ON `webhook_event_deliveries`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'webhook_event_deliveries_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `plugin_event_deliveries_status_insert_guard`
BEFORE INSERT ON `plugin_event_deliveries`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'plugin_event_deliveries_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `plugin_event_deliveries_status_update_guard`
BEFORE UPDATE OF `status` ON `plugin_event_deliveries`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'plugin_event_deliveries_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `notification_outbox_status_insert_guard`
BEFORE INSERT ON `notification_outbox`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'sent', 'failed', 'dead_lettered')
BEGIN
  SELECT RAISE(ABORT, 'notification_outbox_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `notification_outbox_status_update_guard`
BEFORE UPDATE OF `status` ON `notification_outbox`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'sent', 'failed', 'dead_lettered')
BEGIN
  SELECT RAISE(ABORT, 'notification_outbox_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `notification_delivery_receipts_status_insert_guard`
BEFORE INSERT ON `notification_delivery_receipts`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'skipped')
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_receipts_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `notification_delivery_receipts_status_update_guard`
BEFORE UPDATE OF `status` ON `notification_delivery_receipts`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'skipped')
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_receipts_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `webhook_events_status_insert_guard`
BEFORE INSERT ON `webhook_events`
WHEN NEW.`status` NOT IN ('processing', 'retrying', 'processed', 'failed', 'manual_reconciliation')
BEGIN
  SELECT RAISE(ABORT, 'webhook_events_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `webhook_events_status_update_guard`
BEFORE UPDATE OF `status` ON `webhook_events`
WHEN NEW.`status` NOT IN ('processing', 'retrying', 'processed', 'failed', 'manual_reconciliation')
BEGIN
  SELECT RAISE(ABORT, 'webhook_events_status_check');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (221, '0221_queue_claims_and_status_checks', '95800d5f9ef506ddf20f1ede7357f730502d3c9872254b607bbdce7bbf675e40');
