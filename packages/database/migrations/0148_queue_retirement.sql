DROP INDEX `notification_outbox_queued_idx`;
--> statement-breakpoint
DROP INDEX `event_outbox_queued_idx`;
--> statement-breakpoint
DROP INDEX `webhook_event_deliveries_queued_idx`;
--> statement-breakpoint
DROP INDEX `plugin_event_deliveries_queued_idx`;
--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `payload` text;
--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `next_attempt_at` integer;
--> statement-breakpoint
UPDATE `notification_outbox` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `event_outbox` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `webhook_event_deliveries` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `plugin_event_deliveries` SET `status` = 'pending', `claim_id` = NULL, `claim_expires_at` = NULL, `next_attempt_at` = unixepoch() WHERE `status` IN ('enqueueing', 'queued');
--> statement-breakpoint
UPDATE `webhook_events` SET `status` = 'failed' WHERE `status` = 'queued';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (148, '0148_queue_retirement', 'd903535e44c7c404bbd08c2951a91becc2096b6d51f7d3cfb7a1299be91dfd9f');
