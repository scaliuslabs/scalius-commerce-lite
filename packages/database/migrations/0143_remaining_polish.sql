CREATE TABLE `marketing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`content_json` text NOT NULL,
	`audience_json` text NOT NULL,
	`segment_id` text NOT NULL,
	`segment_revision` integer NOT NULL,
	`segment_name` text NOT NULL,
	`time_zone` text NOT NULL,
	`evaluated_at` integer,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enroll_cursor` text,
	`dispatch_cursor` text,
	`step` integer DEFAULT 0 NOT NULL,
	`enrolled_count` integer DEFAULT 0 NOT NULL,
	`deduplicated_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`cancelled_by` text,
	`started_at` integer,
	`finished_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "marketing_runs_channel" CHECK("marketing_runs"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "marketing_runs_status" CHECK("marketing_runs"."status" IN ('scheduled', 'enrolling', 'sending', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "marketing_runs_content" CHECK(json_valid("marketing_runs"."content_json") AND length("marketing_runs"."content_json") <= 64000),
	CONSTRAINT "marketing_runs_audience" CHECK(json_valid("marketing_runs"."audience_json") AND length("marketing_runs"."audience_json") <= 8000),
	CONSTRAINT "marketing_runs_revision" CHECK("marketing_runs"."revision" > 0 AND "marketing_runs"."draft_revision" > 0 AND "marketing_runs"."segment_revision" > 0),
	CONSTRAINT "marketing_runs_counts" CHECK("marketing_runs"."step" >= 0 AND "marketing_runs"."enrolled_count" >= 0 AND "marketing_runs"."deduplicated_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `marketing_contact_slots` (
	`channel` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`day` text NOT NULL,
	`run_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`channel`, `recipient_hash`, `day`),
	CONSTRAINT "marketing_contact_slots_channel" CHECK("marketing_contact_slots"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "marketing_contact_slots_hash" CHECK(length("marketing_contact_slots"."recipient_hash") = 64),
	CONSTRAINT "marketing_contact_slots_day" CHECK(length("marketing_contact_slots"."day") = 10)
);
--> statement-breakpoint
CREATE INDEX `marketing_contact_slots_retention_idx` ON `marketing_contact_slots` (`day`);
--> statement-breakpoint
CREATE TABLE `marketing_run_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`outbox_id` text,
	`status` text DEFAULT 'enrolled' NOT NULL,
	`reason` text,
	`dispatch_started_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `marketing_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "marketing_run_recipients_status" CHECK("marketing_run_recipients"."status" IN ('enrolled', 'queued', 'sending', 'accepted', 'delivered', 'failed', 'unconfirmed', 'skipped', 'cancelled')),
	CONSTRAINT "marketing_run_recipients_hash" CHECK(length("marketing_run_recipients"."recipient_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_run_recipients_target_unique` ON `marketing_run_recipients` (`run_id`,`recipient_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_run_recipients_outbox_unique` ON `marketing_run_recipients` (`outbox_id`) WHERE "marketing_run_recipients"."outbox_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `marketing_run_recipients_progress_idx` ON `marketing_run_recipients` (`run_id`,`status`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_runs_request_unique` ON `marketing_runs` (`plugin_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `marketing_runs_due_idx` ON `marketing_runs` (`status`,`scheduled_at`,`id`);
--> statement-breakpoint
CREATE INDEX `marketing_runs_app_list_idx` ON `marketing_runs` (`plugin_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `conversation_cart_shares` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`lines_json` text NOT NULL,
	`shared_at` integer NOT NULL,
	`withdrawn_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_cart_shares_lines" CHECK(json_valid("conversation_cart_shares"."lines_json") AND length("conversation_cart_shares"."lines_json") <= 120000),
	CONSTRAINT "conversation_cart_shares_version" CHECK("conversation_cart_shares"."version" > 0),
	CONSTRAINT "conversation_cart_shares_withdrawn_empty" CHECK("conversation_cart_shares"."withdrawn_at" IS NULL OR "conversation_cart_shares"."lines_json" = '[]')
);
--> statement-breakpoint
CREATE TABLE `conversation_saved_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`mode` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversation_saved_replies_title_length" CHECK(length(trim("conversation_saved_replies"."title")) BETWEEN 1 AND 80),
	CONSTRAINT "conversation_saved_replies_body_length" CHECK(length(trim("conversation_saved_replies"."body")) BETWEEN 1 AND 5000),
	CONSTRAINT "conversation_saved_replies_mode" CHECK("conversation_saved_replies"."mode" IN ('reply', 'note')),
	CONSTRAINT "conversation_saved_replies_version" CHECK("conversation_saved_replies"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `conversation_saved_replies_all_idx` ON `conversation_saved_replies` (`archived_at`,"updated_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX `conversation_saved_replies_list_idx` ON `conversation_saved_replies` (`archived_at`,`mode`,"updated_at" DESC,`id`);
--> statement-breakpoint
CREATE TABLE `conversation_search_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_message_id` text,
	`complete` integer DEFAULT false NOT NULL,
	CONSTRAINT "conversation_search_state_id" CHECK("conversation_search_state"."id" = 'v1')
);
--> statement-breakpoint
CREATE TABLE `conversation_search_terms` (
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`term` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `term`, `message_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_search_terms_length" CHECK(length("conversation_search_terms"."term") BETWEEN 2 AND 32)
);
--> statement-breakpoint
CREATE INDEX `conversation_search_terms_message_idx` ON `conversation_search_terms` (`conversation_id`,`seq`,`term`);
--> statement-breakpoint
CREATE TABLE `__new_customer_marketing_consents` (
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
	CONSTRAINT "customer_marketing_consents_channel_check" CHECK("__new_customer_marketing_consents"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "customer_marketing_consents_state_check" CHECK("__new_customer_marketing_consents"."state" IN ('subscribed', 'unsubscribed', 'pending')),
	CONSTRAINT "customer_marketing_consents_source_check" CHECK("__new_customer_marketing_consents"."source" IN ('checkout', 'account', 'newsletter', 'admin', 'import', 'plugin', 'link')),
	CONSTRAINT "customer_marketing_consents_actor_check" CHECK("__new_customer_marketing_consents"."actor" IN ('buyer', 'staff', 'plugin', 'system')),
	CONSTRAINT "customer_marketing_consents_pending_email" CHECK("__new_customer_marketing_consents"."state" <> 'pending' OR "__new_customer_marketing_consents"."channel" = 'email'),
	CONSTRAINT "customer_marketing_consents_pending_shape" CHECK(("__new_customer_marketing_consents"."state" = 'pending') = ("__new_customer_marketing_consents"."confirmation_hash" IS NOT NULL AND "__new_customer_marketing_consents"."requested_at" IS NOT NULL)),
	CONSTRAINT "customer_marketing_consents_subscribed_shape" CHECK("__new_customer_marketing_consents"."state" <> 'subscribed' OR "__new_customer_marketing_consents"."subscribed_at" IS NOT NULL),
	CONSTRAINT "customer_marketing_consents_contact_length" CHECK(length("__new_customer_marketing_consents"."contact") BETWEEN 3 AND 320),
	CONSTRAINT "customer_marketing_consents_note_length" CHECK("__new_customer_marketing_consents"."note" IS NULL OR length("__new_customer_marketing_consents"."note") BETWEEN 1 AND 500),
	CONSTRAINT "customer_marketing_consents_text_length" CHECK(("__new_customer_marketing_consents"."consent_text_version" IS NULL OR length("__new_customer_marketing_consents"."consent_text_version") BETWEEN 3 AND 64) AND ("__new_customer_marketing_consents"."consent_text" IS NULL OR length("__new_customer_marketing_consents"."consent_text") BETWEEN 1 AND 500))
);
--> statement-breakpoint
INSERT INTO `__new_customer_marketing_consents`("customer_id", "channel", "state", "contact", "source", "actor", "actor_id", "note", "consent_text_version", "consent_text", "subscribed_at", "unsubscribed_at", "requested_at", "confirmation_hash", "created_at", "updated_at") SELECT "customer_id", "channel", "state", "contact", "source", "actor", "actor_id", "note", "consent_text_version", "consent_text", "subscribed_at", "unsubscribed_at", "requested_at", "confirmation_hash", "created_at", "updated_at" FROM `customer_marketing_consents`;
--> statement-breakpoint
DROP TABLE `customer_marketing_consents`;
--> statement-breakpoint
ALTER TABLE `__new_customer_marketing_consents` RENAME TO `customer_marketing_consents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_marketing_consents_confirmation_unique` ON `customer_marketing_consents` (`confirmation_hash`) WHERE "customer_marketing_consents"."confirmation_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `customer_marketing_consents_channel_state_idx` ON `customer_marketing_consents` (`channel`,`state`,`customer_id`);
--> statement-breakpoint
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
	CONSTRAINT "notification_outbox_payload_json" CHECK(json_valid("__new_notification_outbox"."payload"))
);
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
	CONSTRAINT "notification_delivery_receipts_order_shape" CHECK("__new_notification_delivery_receipts"."subject_type" <> 'order' OR "__new_notification_delivery_receipts"."order_id" IS "__new_notification_delivery_receipts"."subject_id")
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox`("id", "dedupe_key", "subject_type", "subject_id", "order_id", "conversation_id", "audience", "notification_type", "source", "payload", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "queued_at", "sent_at", "created_at", "updated_at") SELECT "id", "dedupe_key", "subject_type", "subject_id", "order_id", "conversation_id", "audience", "notification_type", "source", "payload", "status", "attempts", "next_attempt_at", "claim_id", "claim_expires_at", "last_error", "queued_at", "sent_at", "created_at", "updated_at" FROM `notification_outbox`;
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
CREATE INDEX `conversation_messages_public_seq_idx` ON `conversation_messages` (`conversation_id`,`seq`) WHERE "conversation_messages"."visibility" = 'public';
--> statement-breakpoint
CREATE TRIGGER conversation_product_reply_shape
BEFORE INSERT ON conversation_messages
WHEN NEW.event_kind = 'product_reply' AND (
  NEW.visibility <> 'public' OR NEW.author_type <> 'staff' OR NEW.event_data IS NULL
  OR (NEW.body IS NOT NULL AND length(trim(NEW.body)) = 0)
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid public product reply');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (143, '0143_remaining_polish', 'd479468027dc2a6b0506b24e8bed8a57a1a9bc82067e2497abea5691fdeacb00');
