-- Chat channels in the inbox, and payouts (COMMERCE-HOOKS H18).
--
-- Inbox: a messaging app delivers buyers' WhatsApp, Messenger, … messages.
-- Each contact has one thread: a store thread of the contact's customer,
-- marked with its channel (`conversations.channel`, added in place: no
-- rebuild), its contact and provider in `conversation_channel_contacts`
-- (unique by channel and contact). `conversation_channel_messages` keeps each
-- line as the channel knows it: the provider's message id (unique per
-- provider, so a redelivery is applied once), inbound attachments as
-- references, and an outbound reply's delivery status. An app's staff line
-- names the app (`conversation_messages.author_app_id`, added in place).
--
-- Payouts: one row per payout an app sends through a payout provider,
-- committed before the provider is called, unique per app and idempotency
-- key. Triggers keep who, how much and to whom immutable, move the status
-- forward only (paid and failed are final) and refuse a delete.
--
-- Events: `conversation.message_received` (a buyer's message line),
-- `payout.created` and `payout.updated`, demand-gated like every topic.
CREATE TABLE `conversation_channel_contacts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`contact_key` text NOT NULL,
	`contact_name` text,
	`provider_id` text NOT NULL,
	`last_inbound_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_channel_contacts_channel_check" CHECK("conversation_channel_contacts"."channel" IN ('whatsapp', 'messenger', 'instagram', 'telegram', 'viber')),
	CONSTRAINT "conversation_channel_contacts_key_length" CHECK(length("conversation_channel_contacts"."contact_key") BETWEEN 1 AND 128),
	CONSTRAINT "conversation_channel_contacts_name_length" CHECK("conversation_channel_contacts"."contact_name" IS NULL OR length("conversation_channel_contacts"."contact_name") BETWEEN 1 AND 200),
	CONSTRAINT "conversation_channel_contacts_provider_shape" CHECK(instr("conversation_channel_contacts"."provider_id", ':') > 1 AND length("conversation_channel_contacts"."provider_id") <= 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_channel_contacts_contact_unique` ON `conversation_channel_contacts` (`channel`,`contact_key`);--> statement-breakpoint
CREATE TABLE `conversation_channel_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`direction` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`attachments` text,
	`failure` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_channel_messages_direction_check" CHECK("conversation_channel_messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "conversation_channel_messages_status_shape" CHECK(("conversation_channel_messages"."direction" = 'inbound' AND "conversation_channel_messages"."status" = 'received' AND "conversation_channel_messages"."provider_message_id" IS NOT NULL) OR ("conversation_channel_messages"."direction" = 'outbound' AND "conversation_channel_messages"."status" IN ('pending', 'sent', 'delivered', 'read', 'failed'))),
	CONSTRAINT "conversation_channel_messages_provider_message_length" CHECK("conversation_channel_messages"."provider_message_id" IS NULL OR length("conversation_channel_messages"."provider_message_id") BETWEEN 1 AND 256),
	CONSTRAINT "conversation_channel_messages_attachments_check" CHECK("conversation_channel_messages"."attachments" IS NULL OR (json_valid("conversation_channel_messages"."attachments") AND length("conversation_channel_messages"."attachments") <= 8000)),
	CONSTRAINT "conversation_channel_messages_failure_length" CHECK("conversation_channel_messages"."failure" IS NULL OR length("conversation_channel_messages"."failure") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_channel_messages_provider_unique` ON `conversation_channel_messages` (`provider_id`,`provider_message_id`) WHERE "conversation_channel_messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversation_channel_messages_conversation_idx` ON `conversation_channel_messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`payee_ref` text NOT NULL,
	`payee_account_ref` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_ref` text,
	`failure_code` text,
	`failure_message` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`settled_at` integer,
	CONSTRAINT "payouts_id_shape" CHECK(substr("payouts"."id", 1, 4) = 'pyt_' AND length("payouts"."id") BETWEEN 12 AND 68),
	CONSTRAINT "payouts_app_id_length" CHECK(length("payouts"."app_id") BETWEEN 3 AND 100),
	CONSTRAINT "payouts_provider_shape" CHECK(instr("payouts"."provider_id", ':') > 1 AND length("payouts"."provider_id") <= 160),
	CONSTRAINT "payouts_payee_ref_length" CHECK(length("payouts"."payee_ref") BETWEEN 1 AND 128),
	CONSTRAINT "payouts_payee_account_ref_length" CHECK("payouts"."payee_account_ref" IS NULL OR length("payouts"."payee_account_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payouts_amount_positive" CHECK("payouts"."amount_minor" > 0),
	CONSTRAINT "payouts_currency_shape" CHECK(length("payouts"."currency") = 3 AND upper("payouts"."currency") = "payouts"."currency"),
	CONSTRAINT "payouts_description_length" CHECK("payouts"."description" IS NULL OR length("payouts"."description") BETWEEN 1 AND 200),
	CONSTRAINT "payouts_status_check" CHECK("payouts"."status" IN ('pending', 'processing', 'paid', 'failed')),
	CONSTRAINT "payouts_provider_ref_length" CHECK("payouts"."provider_ref" IS NULL OR length("payouts"."provider_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payouts_failure_shape" CHECK(("payouts"."status" = 'failed') = ("payouts"."failure_code" IS NOT NULL) AND ("payouts"."failure_code" IS NULL OR length("payouts"."failure_code") BETWEEN 1 AND 64) AND ("payouts"."failure_message" IS NULL OR length("payouts"."failure_message") BETWEEN 1 AND 300)),
	CONSTRAINT "payouts_settled_shape" CHECK(("payouts"."status" IN ('paid', 'failed')) = ("payouts"."settled_at" IS NOT NULL)),
	CONSTRAINT "payouts_key_length" CHECK(length("payouts"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "payouts_request_hash_shape" CHECK(length("payouts"."request_hash") = 64),
	CONSTRAINT "payouts_version_positive" CHECK("payouts"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_app_key_unique` ON `payouts` (`app_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_provider_ref_unique` ON `payouts` (`provider_id`,`provider_ref`) WHERE "payouts"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `payouts_app_updated_idx` ON `payouts` (`app_id`,`updated_at`,`id`);--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `author_app_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `channel` text;
--> statement-breakpoint
CREATE TRIGGER `payouts_identity_immutable`
BEFORE UPDATE ON `payouts`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`app_id` IS NOT OLD.`app_id` OR NEW.`provider_id` IS NOT OLD.`provider_id`
  OR NEW.`payee_ref` IS NOT OLD.`payee_ref` OR NEW.`payee_account_ref` IS NOT OLD.`payee_account_ref`
  OR NEW.`amount_minor` IS NOT OLD.`amount_minor` OR NEW.`currency` IS NOT OLD.`currency`
  OR NEW.`description` IS NOT OLD.`description` OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key`
  OR NEW.`request_hash` IS NOT OLD.`request_hash` OR NEW.`created_at` IS NOT OLD.`created_at`
  OR (OLD.`provider_ref` IS NOT NULL AND NEW.`provider_ref` IS NOT OLD.`provider_ref`)
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `payouts_status_forward`
BEFORE UPDATE OF `status` ON `payouts`
WHEN NEW.`status` IS NOT OLD.`status` AND (OLD.`status` IN ('paid', 'failed') OR NEW.`status` = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_STATUS_FINAL');
END;
--> statement-breakpoint
CREATE TRIGGER `payouts_delete_blocked`
BEFORE DELETE ON `payouts`
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_DELETE_BLOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `evt_conversation_messages_received` AFTER INSERT ON `conversation_messages`
WHEN (NEW.`kind` = 'message' AND NEW.`author_type` IN ('customer', 'guest_receipt')) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'conversation.*', 'conversation.message_received'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'conversation.message_received', 'conversation', NEW.`conversation_id`, json_object('conversationId', NEW.`conversation_id`, 'messageId', NEW.`id`, 'seq', NEW.`seq`, 'channel', (SELECT `channel` FROM `conversations` WHERE `id` = NEW.`conversation_id`)));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payouts_insert` AFTER INSERT ON `payouts`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payout.created', 'payout', NEW.`id`, json_object('payoutId', NEW.`id`, 'appId', NEW.`app_id`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payouts_update` AFTER UPDATE ON `payouts`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payout.updated', 'payout', NEW.`id`, json_object('payoutId', NEW.`id`, 'appId', NEW.`app_id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (199, '0199_channel_inbox_payouts', 'ec56959f4179fb753557083b23eecb873fe23cd0329cdc67a8bacd6846b4b61c');
