-- Payout reversals and apps' own chat channels (COMMERCE-HOOKS H18).
--
-- Payout reversals: money an app takes back from a `paid` payout through its
-- payout provider (a marketplace clawing back a seller's share after a
-- refund). One row per reversal, committed `pending` before the provider is
-- called, unique per app and idempotency key with the request's hash. The
-- insert triggers refuse a reversal of a payout that is not `paid`, not the
-- app's, of another provider or currency, one that would take back more than
-- the payout less its reversals that have not failed, and a 21st. Triggers
-- keep the identity immutable, move the status forward only (`pending`,
-- `processing`, then `reversed` or `failed`, both final), refuse a delete,
-- and advance the payout's version and updated_at with each insert and status
-- move. Event: `payout.reversal_updated` about the payout, demand-gated.
--
-- Chat channels: a thread's channel may be an app's own channel,
-- `<app id>:<key>` (64 characters at most), delivered only by that app's
-- providers. SQLite rebuilds `conversation_channel_contacts` (nothing
-- references it and it has no triggers) to widen its channel check.
CREATE TABLE `payout_reversals` (
	`id` text PRIMARY KEY NOT NULL,
	`payout_id` text NOT NULL,
	`app_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text,
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
	FOREIGN KEY (`payout_id`) REFERENCES `payouts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payout_reversals_id_shape" CHECK(substr("payout_reversals"."id", 1, 4) = 'pyr_' AND length("payout_reversals"."id") BETWEEN 12 AND 68),
	CONSTRAINT "payout_reversals_amount_positive" CHECK("payout_reversals"."amount_minor" > 0),
	CONSTRAINT "payout_reversals_currency_shape" CHECK(length("payout_reversals"."currency") = 3 AND upper("payout_reversals"."currency") = "payout_reversals"."currency"),
	CONSTRAINT "payout_reversals_reason_length" CHECK("payout_reversals"."reason" IS NULL OR length("payout_reversals"."reason") BETWEEN 1 AND 200),
	CONSTRAINT "payout_reversals_status_check" CHECK("payout_reversals"."status" IN ('pending', 'processing', 'reversed', 'failed')),
	CONSTRAINT "payout_reversals_provider_ref_length" CHECK("payout_reversals"."provider_ref" IS NULL OR length("payout_reversals"."provider_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payout_reversals_failure_shape" CHECK(("payout_reversals"."status" = 'failed') = ("payout_reversals"."failure_code" IS NOT NULL) AND ("payout_reversals"."failure_code" IS NULL OR length("payout_reversals"."failure_code") BETWEEN 1 AND 64) AND ("payout_reversals"."failure_message" IS NULL OR length("payout_reversals"."failure_message") BETWEEN 1 AND 300)),
	CONSTRAINT "payout_reversals_settled_shape" CHECK(("payout_reversals"."status" IN ('reversed', 'failed')) = ("payout_reversals"."settled_at" IS NOT NULL)),
	CONSTRAINT "payout_reversals_key_length" CHECK(length("payout_reversals"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "payout_reversals_request_hash_shape" CHECK(length("payout_reversals"."request_hash") = 64),
	CONSTRAINT "payout_reversals_version_positive" CHECK("payout_reversals"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_reversals_app_key_unique` ON `payout_reversals` (`app_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_reversals_provider_ref_unique` ON `payout_reversals` (`provider_id`,`provider_ref`) WHERE "payout_reversals"."provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `payout_reversals_payout_idx` ON `payout_reversals` (`payout_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `__new_conversation_channel_contacts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`contact_key` text NOT NULL,
	`contact_name` text,
	`provider_id` text NOT NULL,
	`last_inbound_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_channel_contacts_channel_check" CHECK("__new_conversation_channel_contacts"."channel" IN ('whatsapp', 'messenger', 'instagram', 'telegram', 'viber') OR (instr("__new_conversation_channel_contacts"."channel", ':') > 1 AND length("__new_conversation_channel_contacts"."channel") <= 64 AND substr("__new_conversation_channel_contacts"."channel", 1, CAST(instr("__new_conversation_channel_contacts"."channel", ':') AS smallint)) = substr("__new_conversation_channel_contacts"."provider_id", 1, CAST(instr("__new_conversation_channel_contacts"."provider_id", ':') AS smallint)))),
	CONSTRAINT "conversation_channel_contacts_key_length" CHECK(length("__new_conversation_channel_contacts"."contact_key") BETWEEN 1 AND 128),
	CONSTRAINT "conversation_channel_contacts_name_length" CHECK("__new_conversation_channel_contacts"."contact_name" IS NULL OR length("__new_conversation_channel_contacts"."contact_name") BETWEEN 1 AND 200),
	CONSTRAINT "conversation_channel_contacts_provider_shape" CHECK(instr("__new_conversation_channel_contacts"."provider_id", ':') > 1 AND length("__new_conversation_channel_contacts"."provider_id") <= 160)
);
--> statement-breakpoint
INSERT INTO `__new_conversation_channel_contacts`("conversation_id", "channel", "contact_key", "contact_name", "provider_id", "last_inbound_at", "created_at", "updated_at") SELECT "conversation_id", "channel", "contact_key", "contact_name", "provider_id", "last_inbound_at", "created_at", "updated_at" FROM `conversation_channel_contacts`;
--> statement-breakpoint
DROP TABLE `conversation_channel_contacts`;
--> statement-breakpoint
ALTER TABLE `__new_conversation_channel_contacts` RENAME TO `conversation_channel_contacts`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_channel_contacts_contact_unique` ON `conversation_channel_contacts` (`channel`,`contact_key`);
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_payout_paid`
BEFORE INSERT ON `payout_reversals`
WHEN NOT EXISTS (
  SELECT 1 FROM `payouts`
  WHERE `id` = NEW.`payout_id` AND `app_id` = NEW.`app_id` AND `provider_id` = NEW.`provider_id`
    AND `currency` = NEW.`currency` AND `status` = 'paid'
)
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_REVERSAL_NOT_PAID');
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_within_payout`
BEFORE INSERT ON `payout_reversals`
WHEN (SELECT count(*) FROM `payout_reversals` WHERE `payout_id` = NEW.`payout_id`) >= 20
  OR NEW.`amount_minor` + (
    SELECT coalesce(sum(`amount_minor`), 0) FROM `payout_reversals`
    WHERE `payout_id` = NEW.`payout_id` AND `status` <> 'failed'
  ) > (SELECT `amount_minor` FROM `payouts` WHERE `id` = NEW.`payout_id`)
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_REVERSAL_EXCEEDS_PAYOUT');
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_identity_immutable`
BEFORE UPDATE ON `payout_reversals`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`payout_id` IS NOT OLD.`payout_id` OR NEW.`app_id` IS NOT OLD.`app_id`
  OR NEW.`provider_id` IS NOT OLD.`provider_id` OR NEW.`amount_minor` IS NOT OLD.`amount_minor`
  OR NEW.`currency` IS NOT OLD.`currency` OR NEW.`reason` IS NOT OLD.`reason`
  OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key` OR NEW.`request_hash` IS NOT OLD.`request_hash`
  OR NEW.`created_at` IS NOT OLD.`created_at`
  OR (OLD.`provider_ref` IS NOT NULL AND NEW.`provider_ref` IS NOT OLD.`provider_ref`)
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_REVERSAL_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_status_forward`
BEFORE UPDATE OF `status` ON `payout_reversals`
WHEN NEW.`status` IS NOT OLD.`status` AND (OLD.`status` IN ('reversed', 'failed') OR NEW.`status` = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_REVERSAL_STATUS_FINAL');
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_delete_blocked`
BEFORE DELETE ON `payout_reversals`
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_REVERSAL_DELETE_BLOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_touch_payout_insert`
AFTER INSERT ON `payout_reversals`
BEGIN
  UPDATE `payouts` SET `version` = `version` + 1, `updated_at` = max(`updated_at`, cast(strftime('%s','now') as int)) WHERE `id` = NEW.`payout_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `payout_reversals_touch_payout_status`
AFTER UPDATE OF `status` ON `payout_reversals`
WHEN NEW.`status` IS NOT OLD.`status`
BEGIN
  UPDATE `payouts` SET `version` = `version` + 1, `updated_at` = max(`updated_at`, cast(strftime('%s','now') as int)) WHERE `id` = NEW.`payout_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payout_reversals_insert` AFTER INSERT ON `payout_reversals`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.reversal_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payout.reversal_updated', 'payout', NEW.`payout_id`, json_object('payoutId', NEW.`payout_id`, 'appId', NEW.`app_id`, 'reversalId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payout_reversals_update` AFTER UPDATE ON `payout_reversals`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.reversal_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payout.reversal_updated', 'payout', NEW.`payout_id`, json_object('payoutId', NEW.`payout_id`, 'appId', NEW.`app_id`, 'reversalId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (209, '0209_payout_reversals_custom_channels', '62d7be2d72b1bdd668459884a87136939f5c59eb2778581ce08757f380bfd233');
