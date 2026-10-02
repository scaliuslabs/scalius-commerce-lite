-- Customers & marketing (FEATURE-ROADMAP 3-4): marketing consent per customer
-- and channel (email, sms, whatsapp) with a trigger-written audit log and the
-- customer.consent_changed event, customer tags, saved segments, the
-- trigger-maintained customer_order_stats segments filter on, and the
-- promotion to segment link (buyer-visible: it advances promo:<id>).
-- The notification outbox and its receipts accept a 'customer' subject (the
-- e-mail double opt-in confirmation): both tables are rebuilt in a
-- foreign-key-safe order (copy both, drop the child then the parent, rename
-- the parent first so the child's reference follows it), keeping every row.
-- Order statistics are backfilled from existing orders below.
CREATE TABLE `customer_marketing_consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`previous_state` text,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`note` text,
	`contact` text NOT NULL,
	`consent_text_version` text,
	`consent_text` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_marketing_consent_events_customer_idx` ON `customer_marketing_consent_events` (`customer_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `customer_marketing_consents` (
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`state` text NOT NULL,
	`contact` text NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`note` text,
	`consent_text_version` text,
	`consent_text` text,
	`subscribed_at` integer,
	`unsubscribed_at` integer,
	`requested_at` integer,
	`confirmation_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`customer_id`, `channel`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_marketing_consents_channel_check" CHECK("customer_marketing_consents"."channel" IN ('email', 'sms', 'whatsapp')),
	CONSTRAINT "customer_marketing_consents_state_check" CHECK("customer_marketing_consents"."state" IN ('subscribed', 'unsubscribed', 'pending')),
	CONSTRAINT "customer_marketing_consents_source_check" CHECK("customer_marketing_consents"."source" IN ('checkout', 'account', 'newsletter', 'admin', 'import', 'plugin', 'link')),
	CONSTRAINT "customer_marketing_consents_actor_check" CHECK("customer_marketing_consents"."actor" IN ('buyer', 'staff', 'plugin', 'system')),
	CONSTRAINT "customer_marketing_consents_pending_email" CHECK("customer_marketing_consents"."state" <> 'pending' OR "customer_marketing_consents"."channel" = 'email'),
	CONSTRAINT "customer_marketing_consents_pending_shape" CHECK(("customer_marketing_consents"."state" = 'pending') = ("customer_marketing_consents"."confirmation_hash" IS NOT NULL AND "customer_marketing_consents"."requested_at" IS NOT NULL)),
	CONSTRAINT "customer_marketing_consents_subscribed_shape" CHECK("customer_marketing_consents"."state" <> 'subscribed' OR "customer_marketing_consents"."subscribed_at" IS NOT NULL),
	CONSTRAINT "customer_marketing_consents_contact_length" CHECK(length("customer_marketing_consents"."contact") BETWEEN 3 AND 320),
	CONSTRAINT "customer_marketing_consents_note_length" CHECK("customer_marketing_consents"."note" IS NULL OR length("customer_marketing_consents"."note") BETWEEN 1 AND 500),
	CONSTRAINT "customer_marketing_consents_text_length" CHECK(("customer_marketing_consents"."consent_text_version" IS NULL OR length("customer_marketing_consents"."consent_text_version") BETWEEN 3 AND 64) AND ("customer_marketing_consents"."consent_text" IS NULL OR length("customer_marketing_consents"."consent_text") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_marketing_consents_confirmation_unique` ON `customer_marketing_consents` (`confirmation_hash`) WHERE "customer_marketing_consents"."confirmation_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `customer_marketing_consents_channel_state_idx` ON `customer_marketing_consents` (`channel`,`state`,`customer_id`);
--> statement-breakpoint
CREATE TABLE `customer_order_stats` (
	`customer_id` text PRIMARY KEY NOT NULL,
	`orders_count` integer DEFAULT 0 NOT NULL,
	`total_spent_minor` integer DEFAULT 0 NOT NULL,
	`first_order_at` integer,
	`last_order_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_order_stats_nonnegative" CHECK("customer_order_stats"."orders_count" >= 0 AND "customer_order_stats"."total_spent_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `customer_order_stats_orders_idx` ON `customer_order_stats` (`orders_count`);
--> statement-breakpoint
CREATE INDEX `customer_order_stats_spent_idx` ON `customer_order_stats` (`total_spent_minor`);
--> statement-breakpoint
CREATE INDEX `customer_order_stats_first_order_idx` ON `customer_order_stats` (`first_order_at`);
--> statement-breakpoint
CREATE INDEX `customer_order_stats_last_order_idx` ON `customer_order_stats` (`last_order_at`);
--> statement-breakpoint
CREATE TABLE `customer_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "customer_segments_id_shape" CHECK(substr("customer_segments"."id", 1, 4) = 'seg_' AND length("customer_segments"."id") BETWEEN 8 AND 40),
	CONSTRAINT "customer_segments_name_valid" CHECK("customer_segments"."name" = trim("customer_segments"."name") AND length("customer_segments"."name") BETWEEN 1 AND 80),
	CONSTRAINT "customer_segments_description_length" CHECK("customer_segments"."description" IS NULL OR length("customer_segments"."description") BETWEEN 1 AND 300),
	CONSTRAINT "customer_segments_definition_json" CHECK(json_valid("customer_segments"."definition") AND json_type("customer_segments"."definition") = 'object' AND length("customer_segments"."definition") <= 8000),
	CONSTRAINT "customer_segments_revision_positive" CHECK("customer_segments"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_segments_name_unique` ON `customer_segments` (lower("name")) WHERE "customer_segments"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `customer_segments_list_idx` ON `customer_segments` (`deleted_at`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `customer_tag_links` (
	`customer_id` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`customer_id`, `tag`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_tag_links_tag_shape" CHECK(length("customer_tag_links"."tag") BETWEEN 1 AND 40 AND "customer_tag_links"."tag" = trim("customer_tag_links"."tag") AND "customer_tag_links"."tag" = lower("customer_tag_links"."tag") AND instr("customer_tag_links"."tag", '  ') = 0 AND instr("customer_tag_links"."tag", ',') = 0)
);
--> statement-breakpoint
CREATE INDEX `customer_tag_links_tag_idx` ON `customer_tag_links` (`tag`,`customer_id`);
--> statement-breakpoint
CREATE TABLE `promotion_customer_segments` (
	`promotion_id` text NOT NULL,
	`segment_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`promotion_id`, `segment_id`),
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `customer_segments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `promotion_customer_segments_segment_idx` ON `promotion_customer_segments` (`segment_id`);
--> statement-breakpoint
-- Notification outbox and receipts accept the 'customer' subject (rebuild).
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
	CONSTRAINT "notification_outbox_subject_type_check" CHECK("__new_notification_outbox"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer')),
	CONSTRAINT "notification_outbox_audience_check" CHECK("__new_notification_outbox"."audience" IN ('customer', 'staff')),
	CONSTRAINT "notification_outbox_subject_shape" CHECK(("__new_notification_outbox"."subject_type" <> 'order' OR "__new_notification_outbox"."order_id" IS "__new_notification_outbox"."subject_id") AND ("__new_notification_outbox"."subject_type" <> 'conversation' OR "__new_notification_outbox"."conversation_id" IS "__new_notification_outbox"."subject_id")),
	CONSTRAINT "notification_outbox_payload_json" CHECK(json_valid("__new_notification_outbox"."payload"))
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
	CONSTRAINT "notification_delivery_receipts_subject_type_check" CHECK("__new_notification_delivery_receipts"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer')),
	CONSTRAINT "notification_delivery_receipts_order_shape" CHECK("__new_notification_delivery_receipts"."subject_type" <> 'order' OR "__new_notification_delivery_receipts"."order_id" IS "__new_notification_delivery_receipts"."subject_id")
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
CREATE INDEX `notification_outbox_queued_idx` ON `notification_outbox` (`status`,`queued_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_subject_idx` ON `notification_outbox` (`subject_type`,`subject_id`);
--> statement-breakpoint
CREATE INDEX `notification_outbox_order_id_idx` ON `notification_outbox` (`order_id`) WHERE "notification_outbox"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `notification_outbox_conversation_id_idx` ON `notification_outbox` (`conversation_id`) WHERE "notification_outbox"."conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_receipts_receipt_key_unique` ON `notification_delivery_receipts` (`receipt_key`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_receipts_outbox_id_idx` ON `notification_delivery_receipts` (`outbox_id`);
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
-- Consent audit log: every state or address change, with who and why.
CREATE TRIGGER `customer_marketing_consents_audit_ins` AFTER INSERT ON `customer_marketing_consents`
BEGIN
  INSERT INTO `customer_marketing_consent_events` (`id`, `customer_id`, `channel`, `previous_state`, `state`, `source`, `actor`, `actor_id`, `note`, `contact`, `consent_text_version`, `consent_text`) VALUES ('mce_' || NEW.`customer_id` || '_' || NEW.`channel` || '_' || ((SELECT count(*) FROM `customer_marketing_consent_events` WHERE `customer_id` = NEW.`customer_id` AND `channel` = NEW.`channel`) + 1), NEW.`customer_id`, NEW.`channel`, NULL, NEW.`state`, NEW.`source`, NEW.`actor`, NEW.`actor_id`, NEW.`note`, NEW.`contact`, NEW.`consent_text_version`, NEW.`consent_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `customer_marketing_consents_audit_upd` AFTER UPDATE ON `customer_marketing_consents`
WHEN OLD.`state` IS NOT NEW.`state` OR OLD.`contact` IS NOT NEW.`contact`
BEGIN
  INSERT INTO `customer_marketing_consent_events` (`id`, `customer_id`, `channel`, `previous_state`, `state`, `source`, `actor`, `actor_id`, `note`, `contact`, `consent_text_version`, `consent_text`) VALUES ('mce_' || NEW.`customer_id` || '_' || NEW.`channel` || '_' || ((SELECT count(*) FROM `customer_marketing_consent_events` WHERE `customer_id` = NEW.`customer_id` AND `channel` = NEW.`channel`) + 1), NEW.`customer_id`, NEW.`channel`, OLD.`state`, NEW.`state`, NEW.`source`, NEW.`actor`, NEW.`actor_id`, NEW.`note`, NEW.`contact`, NEW.`consent_text_version`, NEW.`consent_text`);
END;
--> statement-breakpoint
-- customer_order_stats: recomputed from the customer's orders on every
-- order write that can change them (no drift; one indexed aggregate).
CREATE TRIGGER `customer_order_stats_order_ins` AFTER INSERT ON `orders`
WHEN NEW.`customer_id` IS NOT NULL
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(max(`orders`.`paid_amount_minor`, 0)), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = NEW.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_upd` AFTER UPDATE ON `orders`
WHEN NEW.`customer_id` IS NOT NULL AND (OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`paid_amount_minor` IS NOT NEW.`paid_amount_minor` OR OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`created_at` IS NOT NEW.`created_at` OR (OLD.`status` IS NOT NEW.`status` AND (OLD.`status` = 'incomplete' OR NEW.`status` = 'incomplete')))
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(max(`orders`.`paid_amount_minor`, 0)), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = NEW.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_upd_old` AFTER UPDATE ON `orders`
WHEN OLD.`customer_id` IS NOT NULL AND OLD.`customer_id` IS NOT NEW.`customer_id`
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(max(`orders`.`paid_amount_minor`, 0)), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = OLD.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_del` AFTER DELETE ON `orders`
WHEN OLD.`customer_id` IS NOT NULL
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(max(`orders`.`paid_amount_minor`, 0)), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = OLD.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- customer.consent_changed (event-outbox-triggers.ts, generated).
CREATE TRIGGER `evt_customer_marketing_consents_created` AFTER INSERT ON `customer_marketing_consents`
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', NULL, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_marketing_consents_changed` AFTER UPDATE ON `customer_marketing_consents`
WHEN (OLD.`state` IS NOT NEW.`state`)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', OLD.`state`, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
-- promotion_customer_segments cache dependencies (cache-dep-triggers.ts, generated).
CREATE TRIGGER `cdep_promotion_customer_segments_ins` AFTER INSERT ON `promotion_customer_segments`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || NEW.`promotion_id`, 'promo:*', 't:promotion_customer_segments')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_promotion_customer_segments_del` AFTER DELETE ON `promotion_customer_segments`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || OLD.`promotion_id`, 'promo:*', 't:promotion_customer_segments')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_promotion_customer_segments_upd` AFTER UPDATE ON `promotion_customer_segments`
WHEN (OLD.`promotion_id` IS NOT NEW.`promotion_id` OR OLD.`segment_id` IS NOT NEW.`segment_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || NEW.`promotion_id`, 'promo:*', 't:promotion_customer_segments')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_promotion_customer_segments_upd_old` AFTER UPDATE ON `promotion_customer_segments`
WHEN (OLD.`promotion_id` IS NOT NEW.`promotion_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || OLD.`promotion_id`, 'promo:*', 't:promotion_customer_segments')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- Order statistics for every customer with real orders; a customer without a
-- row has none (readers treat a missing row as zeros).
INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`) SELECT `orders`.`customer_id`, count(*), COALESCE(sum(max(`orders`.`paid_amount_minor`, 0)), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)) FROM `orders` JOIN `customers` ON `customers`.`id` = `orders`.`customer_id` WHERE `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' GROUP BY `orders`.`customer_id`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (108, '0108_customer_marketing', 'a4b6972ec3a9e64299d547b220d4682a84a8885d02f78cc2868ae4510e8bb77e');
