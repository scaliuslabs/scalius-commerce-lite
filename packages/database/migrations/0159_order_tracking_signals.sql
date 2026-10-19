-- Server tracking (audit spec S4): the consent snapshot and match signals of a
-- storefront order, and the GA4 / TikTok server deliveries (one per destination
-- and dedup key). A confirmed refund of an order whose GA4 purchase was sent
-- queues its GA4 refund in the refund's own write.
CREATE TABLE `order_tracking_signals` (
	`order_id` text PRIMARY KEY NOT NULL,
	`consent_analytics` integer NOT NULL,
	`consent_marketing` integer NOT NULL,
	`consent_sale_of_data` integer NOT NULL,
	`consent_source` text NOT NULL,
	`fbp` text,
	`fbc` text,
	`ttp` text,
	`ttclid` text,
	`ga_client_id` text,
	`ga_session_id` text,
	`gclid` text,
	`client_ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_tracking_signals_created_idx` ON `order_tracking_signals` (`created_at`);--> statement-breakpoint
CREATE TABLE `tracking_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`destination` text NOT NULL,
	`event_name` text NOT NULL,
	`dedup_key` text NOT NULL,
	`order_id` text NOT NULL,
	`payment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`match_signals` text,
	`last_error` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracking_deliveries_dedup_unique` ON `tracking_deliveries` (`destination`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `tracking_deliveries_due_idx` ON `tracking_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `tracking_deliveries_claim_idx` ON `tracking_deliveries` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `tracking_deliveries_created_idx` ON `tracking_deliveries` (`created_at`);--> statement-breakpoint
CREATE INDEX `tracking_deliveries_order_idx` ON `tracking_deliveries` (`order_id`);--> statement-breakpoint
CREATE TRIGGER `tracking_ga4_refund_insert`
AFTER INSERT ON `order_payments`
WHEN NEW.`payment_type` = 'refund' AND NEW.`status` = 'refunded'
  AND EXISTS (SELECT 1 FROM `tracking_deliveries` WHERE `destination` = 'ga4' AND `dedup_key` = 'purchase:' || NEW.`order_id` AND `status` = 'sent')
BEGIN
  INSERT INTO `tracking_deliveries` (`id`, `destination`, `event_name`, `dedup_key`, `order_id`, `payment_id`)
  VALUES ('trk_' || lower(hex(randomblob(12))), 'ga4', 'refund', 'refund:' || NEW.`id`, NEW.`order_id`, NEW.`id`)
  ON CONFLICT (`destination`, `dedup_key`) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `tracking_ga4_refund_update`
AFTER UPDATE OF `status` ON `order_payments`
WHEN NEW.`payment_type` = 'refund' AND NEW.`status` = 'refunded' AND OLD.`status` IS NOT 'refunded'
  AND EXISTS (SELECT 1 FROM `tracking_deliveries` WHERE `destination` = 'ga4' AND `dedup_key` = 'purchase:' || NEW.`order_id` AND `status` = 'sent')
BEGIN
  INSERT INTO `tracking_deliveries` (`id`, `destination`, `event_name`, `dedup_key`, `order_id`, `payment_id`)
  VALUES ('trk_' || lower(hex(randomblob(12))), 'ga4', 'refund', 'refund:' || NEW.`id`, NEW.`order_id`, NEW.`id`)
  ON CONFLICT (`destination`, `dedup_key`) DO NOTHING;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (159, '0159_order_tracking_signals', '2288de59a047c4daea18883f65b105cf4b2be5fc9004f85311611b0dc9301382');
