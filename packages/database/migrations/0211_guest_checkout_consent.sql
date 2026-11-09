-- Guest consent from an unsubmitted checkout (COMMERCE-HOOKS H20): the
-- checkout's consent box, ticked on a checkout the buyer never placed, files
-- the typed contact's consent with source `unsubmitted_checkout`, the
-- checkout session that gave it (`checkout_session_id`) and when its one
-- marketing message, the cart reminder, was claimed (`reminder_sent_at`).
-- SQLite cannot alter a CHECK, so the table is rebuilt (no foreign key names
-- it); its indexes and its audit, event and erasure triggers are recreated
-- exactly as they stood.
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
	`checkout_session_id` text,
	`reminder_sent_at` integer,
	PRIMARY KEY(`customer_id`, `channel`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_marketing_consents_channel_check" CHECK("__new_customer_marketing_consents"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "customer_marketing_consents_state_check" CHECK("__new_customer_marketing_consents"."state" IN ('subscribed', 'unsubscribed', 'pending')),
	CONSTRAINT "customer_marketing_consents_source_check" CHECK("__new_customer_marketing_consents"."source" IN ('checkout', 'account', 'newsletter', 'admin', 'import', 'plugin', 'link', 'unsubmitted_checkout')),
	CONSTRAINT "customer_marketing_consents_actor_check" CHECK("__new_customer_marketing_consents"."actor" IN ('buyer', 'staff', 'plugin', 'system')),
	CONSTRAINT "customer_marketing_consents_pending_email" CHECK("__new_customer_marketing_consents"."state" <> 'pending' OR "__new_customer_marketing_consents"."channel" = 'email'),
	CONSTRAINT "customer_marketing_consents_pending_shape" CHECK(("__new_customer_marketing_consents"."state" = 'pending') = ("__new_customer_marketing_consents"."confirmation_hash" IS NOT NULL AND "__new_customer_marketing_consents"."requested_at" IS NOT NULL)),
	CONSTRAINT "customer_marketing_consents_subscribed_shape" CHECK("__new_customer_marketing_consents"."state" <> 'subscribed' OR "__new_customer_marketing_consents"."subscribed_at" IS NOT NULL),
	CONSTRAINT "customer_marketing_consents_contact_length" CHECK(length("__new_customer_marketing_consents"."contact") BETWEEN 3 AND 320),
	CONSTRAINT "customer_marketing_consents_checkout_shape" CHECK(("__new_customer_marketing_consents"."source" = 'unsubmitted_checkout') = ("__new_customer_marketing_consents"."checkout_session_id" IS NOT NULL) OR "__new_customer_marketing_consents"."state" = 'unsubscribed'),
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
CREATE INDEX `customer_marketing_consents_checkout_idx` ON `customer_marketing_consents` (`checkout_session_id`) WHERE "customer_marketing_consents"."checkout_session_id" IS NOT NULL;
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
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', NULL, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_marketing_consents_changed` AFTER UPDATE ON `customer_marketing_consents`
WHEN (OLD.`state` IS NOT NEW.`state`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', OLD.`state`, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
CREATE TRIGGER `customer_marketing_consents_erased_owner_blocked`
BEFORE INSERT ON `customer_marketing_consents`
WHEN EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_marketing_consents_erased_owner_moved`
BEFORE UPDATE OF `customer_id` ON `customer_marketing_consents`
WHEN NEW.`customer_id` IS NOT OLD.`customer_id` AND EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (211, '0211_guest_checkout_consent', 'c31089b2cc7c0b3c0c0f1e5c8377f133b0fcd6ffc85f09af606b2e9709f46fad');
