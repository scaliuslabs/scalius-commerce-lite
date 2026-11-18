-- Status CHECKs that allow exactly the states the code declares, a claim
-- token on webhook_events, and a stall count on bulk_runs.
-- Each rebuilt table is copied whole: a row whose status the new CHECK
-- refuses aborts the migration and changes nothing.
-- Webhook and app event deliveries: 0148 retired enqueueing and queued.
CREATE TABLE `__new_webhook_event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text,
	`kind` text DEFAULT 'event' NOT NULL,
	`topic` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`queued_at` integer,
	`last_attempt_at` integer,
	`response_status` integer,
	`duration_ms` integer,
	`response_excerpt` text,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `event_outbox`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "webhook_event_deliveries_kind_check" CHECK("__new_webhook_event_deliveries"."kind" IN ('event', 'test')),
	CONSTRAINT "webhook_event_deliveries_status_check" CHECK("__new_webhook_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')),
	CONSTRAINT "webhook_event_deliveries_excerpt_length" CHECK("__new_webhook_event_deliveries"."response_excerpt" IS NULL OR length("__new_webhook_event_deliveries"."response_excerpt") <= 256),
	CONSTRAINT "webhook_event_deliveries_error_length" CHECK("__new_webhook_event_deliveries"."last_error" IS NULL OR length("__new_webhook_event_deliveries"."last_error") <= 500)
);
--> statement-breakpoint
INSERT INTO `__new_webhook_event_deliveries`("id", "subscription_id", "event_id", "kind", "topic", "resource_type", "resource_id", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "queued_at", "last_attempt_at", "response_status", "duration_ms", "response_excerpt", "last_error", "delivered_at", "created_at", "updated_at") SELECT "id", "subscription_id", "event_id", "kind", "topic", "resource_type", "resource_id", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "queued_at", "last_attempt_at", "response_status", "duration_ms", "response_excerpt", "last_error", "delivered_at", "created_at", "updated_at" FROM `webhook_event_deliveries`;
--> statement-breakpoint
DROP TABLE `webhook_event_deliveries`;
--> statement-breakpoint
ALTER TABLE `__new_webhook_event_deliveries` RENAME TO `webhook_event_deliveries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_event_deliveries_subscription_event_unique` ON `webhook_event_deliveries` (`subscription_id`,`event_id`) WHERE "webhook_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `webhook_event_deliveries_due_idx` ON `webhook_event_deliveries` (`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `webhook_event_deliveries_claim_idx` ON `webhook_event_deliveries` (`status`,`claim_expires_at`);
--> statement-breakpoint
CREATE INDEX `webhook_event_deliveries_subscription_created_idx` ON `webhook_event_deliveries` (`subscription_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `webhook_event_deliveries_event_idx` ON `webhook_event_deliveries` (`event_id`) WHERE "webhook_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `webhook_event_deliveries_created_idx` ON `webhook_event_deliveries` (`created_at`);
--> statement-breakpoint
CREATE TABLE `__new_plugin_event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`event_id` text,
	`topic` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`queued_at` integer,
	`last_attempt_at` integer,
	`duration_ms` integer,
	`last_error` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `event_outbox`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plugin_event_deliveries_id_shape" CHECK(length("__new_plugin_event_deliveries"."id") = 29 AND substr("__new_plugin_event_deliveries"."id", 1, 4) = 'pld_'),
	CONSTRAINT "plugin_event_deliveries_plugin_id_shape" CHECK(length("__new_plugin_event_deliveries"."plugin_id") BETWEEN 3 AND 100 AND "__new_plugin_event_deliveries"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("__new_plugin_event_deliveries"."plugin_id", '.') > 1 AND instr("__new_plugin_event_deliveries"."plugin_id", '.') < length("__new_plugin_event_deliveries"."plugin_id")),
	CONSTRAINT "plugin_event_deliveries_status_check" CHECK("__new_plugin_event_deliveries"."status" IN ('pending', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')),
	CONSTRAINT "plugin_event_deliveries_attempts_nonnegative" CHECK("__new_plugin_event_deliveries"."attempts" >= 0),
	CONSTRAINT "plugin_event_deliveries_error_length" CHECK("__new_plugin_event_deliveries"."last_error" IS NULL OR length("__new_plugin_event_deliveries"."last_error") <= 500)
);
--> statement-breakpoint
INSERT INTO `__new_plugin_event_deliveries`("id", "plugin_id", "event_id", "topic", "resource_type", "resource_id", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "queued_at", "last_attempt_at", "duration_ms", "last_error", "delivered_at", "created_at", "updated_at") SELECT "id", "plugin_id", "event_id", "topic", "resource_type", "resource_id", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "queued_at", "last_attempt_at", "duration_ms", "last_error", "delivered_at", "created_at", "updated_at" FROM `plugin_event_deliveries`;
--> statement-breakpoint
DROP TABLE `plugin_event_deliveries`;
--> statement-breakpoint
ALTER TABLE `__new_plugin_event_deliveries` RENAME TO `plugin_event_deliveries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_event_deliveries_plugin_event_unique` ON `plugin_event_deliveries` (`plugin_id`,`event_id`) WHERE "plugin_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_due_idx` ON `plugin_event_deliveries` (`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_claim_idx` ON `plugin_event_deliveries` (`status`,`claim_expires_at`);
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_plugin_idx` ON `plugin_event_deliveries` (`plugin_id`,`id`);
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_plugin_status_idx` ON `plugin_event_deliveries` (`plugin_id`,`status`,`claim_expires_at`);
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_event_idx` ON `plugin_event_deliveries` (`event_id`) WHERE "plugin_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `plugin_event_deliveries_created_idx` ON `plugin_event_deliveries` (`created_at`);
--> statement-breakpoint
-- The dispute requeue trigger names webhook_events, so it goes before the
-- table is rebuilt and comes back after.
DROP TRIGGER IF EXISTS `refund_attempts_settled_requeue_disputes`;
--> statement-breakpoint
CREATE TABLE `__new_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text NOT NULL,
	`order_id` text,
	`status` text DEFAULT 'processed' NOT NULL,
	`result` text,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claim_id` text,
	`processed_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK("__new_webhook_events"."status" IN ('processing', 'retrying', 'processed', 'failed', 'manual_reconciliation'))
);
--> statement-breakpoint
INSERT INTO `__new_webhook_events`("id", "provider", "event_type", "order_id", "status", "result", "payload", "attempts", "next_attempt_at", "processed_at") SELECT "id", "provider", "event_type", "order_id", "status", "result", "payload", "attempts", "next_attempt_at", "processed_at" FROM `webhook_events`;
--> statement-breakpoint
DROP TABLE `webhook_events`;
--> statement-breakpoint
ALTER TABLE `__new_webhook_events` RENAME TO `webhook_events`;
--> statement-breakpoint
CREATE INDEX `webhook_events_provider_idx` ON `webhook_events` (`provider`);
--> statement-breakpoint
CREATE INDEX `webhook_events_order_id_idx` ON `webhook_events` (`order_id`);
--> statement-breakpoint
CREATE INDEX `webhook_events_status_processed_at_idx` ON `webhook_events` (`status`,`processed_at`);
--> statement-breakpoint
CREATE TRIGGER refund_attempts_settled_requeue_disputes
AFTER UPDATE OF status ON refund_attempts
WHEN OLD.status IN ('pending', 'processing', 'provider_unknown', 'reconcile_required') AND NEW.status NOT IN ('pending', 'processing', 'provider_unknown', 'reconcile_required')
BEGIN
  UPDATE webhook_events SET next_attempt_at = unixepoch()
  WHERE order_id = NEW.order_id AND status = 'retrying' AND json_extract(result, '$.reason') = 'refund_in_flight';
END;
--> statement-breakpoint
-- Counts claims a live drain never handed back (bulk-runs/engine.ts).
ALTER TABLE `bulk_runs` ADD `stalls` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- The notification outbox and its receipts: the receipts are rebuilt against
-- the new outbox, so dropping the old one cascades into no receipt.
CREATE TABLE `__new_notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`order_id` text,
	`conversation_id` text,
	`audience` text NOT NULL,
	`notification_type` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`queued_at` integer,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_outbox_subject_type_check" CHECK("__new_notification_outbox"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer', 'marketing_run')),
	CONSTRAINT "notification_outbox_audience_check" CHECK("__new_notification_outbox"."audience" IN ('customer', 'staff')),
	CONSTRAINT "notification_outbox_subject_shape" CHECK(("__new_notification_outbox"."subject_type" <> 'order' OR "__new_notification_outbox"."order_id" IS "__new_notification_outbox"."subject_id") AND ("__new_notification_outbox"."subject_type" <> 'conversation' OR "__new_notification_outbox"."conversation_id" IS "__new_notification_outbox"."subject_id")),
	CONSTRAINT "notification_outbox_payload_json" CHECK(json_valid("__new_notification_outbox"."payload")),
	CONSTRAINT "notification_outbox_status_check" CHECK("__new_notification_outbox"."status" IN ('pending', 'processing', 'sent', 'failed', 'dead_lettered'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox`("id", "dedupe_key", "subject_type", "subject_id", "order_id", "conversation_id", "audience", "notification_type", "source", "payload", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "queued_at", "sent_at", "created_at", "updated_at") SELECT "id", "dedupe_key", "subject_type", "subject_id", "order_id", "conversation_id", "audience", "notification_type", "source", "payload", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "queued_at", "sent_at", "created_at", "updated_at" FROM `notification_outbox`;
--> statement-breakpoint
CREATE TABLE `__new_notification_delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_key` text NOT NULL,
	`outbox_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`order_id` text,
	`notification_type` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`recipient_masked` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`provider_status` text,
	`raw_response` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`last_attempt_at` integer,
	`accepted_at` integer,
	`delivered_at` integer,
	`failed_at` integer,
	`skipped_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `__new_notification_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_delivery_receipts_subject_type_check" CHECK("__new_notification_delivery_receipts"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer', 'marketing_run')),
	CONSTRAINT "notification_delivery_receipts_order_shape" CHECK("__new_notification_delivery_receipts"."subject_type" <> 'order' OR "__new_notification_delivery_receipts"."order_id" IS "__new_notification_delivery_receipts"."subject_id"),
	CONSTRAINT "notification_delivery_receipts_status_check" CHECK("__new_notification_delivery_receipts"."status" IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_delivery_receipts`("id", "receipt_key", "outbox_id", "subject_type", "subject_id", "order_id", "notification_type", "channel", "provider", "recipient_hash", "recipient_masked", "status", "provider_message_id", "provider_status", "raw_response", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "last_attempt_at", "accepted_at", "delivered_at", "failed_at", "skipped_at", "created_at", "updated_at") SELECT "id", "receipt_key", "outbox_id", "subject_type", "subject_id", "order_id", "notification_type", "channel", "provider", "recipient_hash", "recipient_masked", "status", "provider_message_id", "provider_status", "raw_response", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "last_attempt_at", "accepted_at", "delivered_at", "failed_at", "skipped_at", "created_at", "updated_at" FROM `notification_delivery_receipts`;
--> statement-breakpoint
DROP TABLE `notification_delivery_receipts`;
--> statement-breakpoint
DROP TABLE `notification_outbox`;
--> statement-breakpoint
ALTER TABLE `__new_notification_outbox` RENAME TO `notification_outbox`;
--> statement-breakpoint
ALTER TABLE `__new_notification_delivery_receipts` RENAME TO `notification_delivery_receipts`;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_dedupe_key_unique` ON `notification_outbox` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_pending_idx` ON `notification_outbox` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_claim_idx` ON `notification_outbox` (`status`,`claim_expires_at`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_subject_idx` ON `notification_outbox` (`subject_type`,`subject_id`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_order_id_idx` ON `notification_outbox` (`order_id`) WHERE "notification_outbox"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `notification_outbox_conversation_id_idx` ON `notification_outbox` (`conversation_id`) WHERE "notification_outbox"."conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_receipts_receipt_key_unique` ON `notification_delivery_receipts` (`receipt_key`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_outbox_status_idx` ON `notification_delivery_receipts` (`outbox_id`,`status`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_subject_created_idx` ON `notification_delivery_receipts` (`subject_type`,`subject_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_subject_channel_idx` ON `notification_delivery_receipts` (`subject_type`,`subject_id`,`channel`,`accepted_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_order_id_created_at_idx` ON `notification_delivery_receipts` (`order_id`,`created_at`) WHERE "notification_delivery_receipts"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_pending_idx` ON `notification_delivery_receipts` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_claim_idx` ON `notification_delivery_receipts` (`status`,`claim_expires_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_provider_message_idx` ON `notification_delivery_receipts` (`provider`,`provider_message_id`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_provider_status_updated_idx` ON `notification_delivery_receipts` (`channel`,`provider`,`status`,`updated_at`);
--> statement-breakpoint
-- event_outbox keeps its wider stored CHECK: rebuilding it would drop and
-- reinstall every event trigger. These guards refuse the two retired states.
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
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (221, '0221_queue_claims_and_status_checks', 'ff0b23303905005508dcd8922019c1a96a461c3f27c5eefd06bd8733c097ec62');
