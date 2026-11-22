-- A refund the provider took and is completing has its own status,
-- `provider_processing` (rules/payments/provider-processing-refund-own-status.md):
-- until now it was `provider_unknown` with a provider refund id and no
-- `last_error`, so an error written there locked the order again. The
-- attempts in that state move to it (only those rows are written), and the
-- single-flight index and the dispute requeue trigger, which name the
-- in-flight set, are recreated with it. `needs_staff` says a person must
-- look (a status check that needs one); it starts false on every row.
-- `order_refunds_unsettled_idx` lists the refunds that ended without all
-- their money going back, for Money to return. No table is rebuilt.
ALTER TABLE `refund_attempts` ADD `needs_staff` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `refund_attempts_needs_staff_idx` ON `refund_attempts` (`order_id`) WHERE "refund_attempts"."needs_staff" = 1;
--> statement-breakpoint
CREATE INDEX `order_refunds_unsettled_idx` ON `order_refunds` (`order_id`) WHERE "order_refunds"."status" IN ('failed', 'partial');
--> statement-breakpoint
DROP TRIGGER IF EXISTS refund_attempts_settled_requeue_disputes;
--> statement-breakpoint
DROP INDEX IF EXISTS `refund_attempts_live_source_payment_singleflight`;
--> statement-breakpoint
UPDATE `refund_attempts` SET `status` = 'provider_processing' WHERE `status` = 'provider_unknown' AND `provider_refund_id` IS NOT NULL AND `last_error` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_live_source_payment_singleflight`
ON `refund_attempts` (`source_payment_id`)
WHERE `status` IN ('pending', 'processing', 'provider_unknown', 'provider_processing', 'reconcile_required');
--> statement-breakpoint
CREATE TRIGGER refund_attempts_settled_requeue_disputes
AFTER UPDATE OF status ON refund_attempts
WHEN OLD.status IN ('pending', 'processing', 'provider_unknown', 'provider_processing', 'reconcile_required') AND NEW.status NOT IN ('pending', 'processing', 'provider_unknown', 'provider_processing', 'reconcile_required')
BEGIN
  UPDATE webhook_events SET next_attempt_at = unixepoch()
  WHERE order_id = NEW.order_id AND status = 'retrying' AND json_extract(result, '$.reason') = 'refund_in_flight';
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (222, '0222_refund_provider_processing', '1034538a2f075fece817c0cd85d218abb77b21bdf5427499ac8216559f9a4727');
