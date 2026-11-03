-- An erased customer never regains personal data, from any writer
-- (`eraseCustomer`, migration 0179). The repair below first scrubs any
-- erased record that a writer without the guard gave data back (a staff
-- edit, a restore, an address added after the erasure), exactly as the
-- erasure does; the triggers then refuse it in the database:
--   customers_erased_frozen: an update of an erased record must leave it
--     erased (name '[erased]', no email, no phone, no proofs or sign-in
--     time, no tax registration number, still retired and erased);
--     counters and timestamps may still change.
--   *_erased_owner_blocked: no address, sign-in identity, marketing consent
--     or consent log entry is written for an erased record, and no history
--     entry with its contact.
-- The erasure batch erases the record before it writes its own history
-- entry, so the scrub itself passes. Guards live in each trigger's WHEN
-- clause and every body is one RAISE (remote D1 rejects a body with
-- `SELECT CASE WHEN`).
UPDATE `customers` SET `name` = '[erased]', `email` = NULL, `phone` = '', `phone_verified_at` = NULL, `email_verified_at` = NULL, `last_authenticated_at` = NULL, `tax_exempt` = 0, `tax_exemption_id` = NULL, `deleted_at` = coalesce(`deleted_at`, unixepoch()), `updated_at` = unixepoch()
WHERE `erased_at` IS NOT NULL
  AND (`name` IS NOT '[erased]' OR `email` IS NOT NULL OR `phone` IS NOT '' OR `phone_verified_at` IS NOT NULL OR `email_verified_at` IS NOT NULL OR `last_authenticated_at` IS NOT NULL OR `tax_exemption_id` IS NOT NULL OR `deleted_at` IS NULL);
--> statement-breakpoint
UPDATE `customer_history` SET `name` = '[erased]', `email` = NULL, `phone` = ''
WHERE `customer_id` IN (SELECT `id` FROM `customers` WHERE `erased_at` IS NOT NULL)
  AND (`name` IS NOT '[erased]' OR `email` IS NOT NULL OR `phone` IS NOT '');
--> statement-breakpoint
DELETE FROM `customer_addresses` WHERE `customer_id` IN (SELECT `id` FROM `customers` WHERE `erased_at` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `customer_identities` WHERE `customer_id` IN (SELECT `id` FROM `customers` WHERE `erased_at` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `customer_marketing_consents` WHERE `customer_id` IN (SELECT `id` FROM `customers` WHERE `erased_at` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `customer_marketing_consent_events` WHERE `customer_id` IN (SELECT `id` FROM `customers` WHERE `erased_at` IS NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `customers_erased_frozen`
BEFORE UPDATE ON `customers`
WHEN OLD.`erased_at` IS NOT NULL
  AND (NEW.`erased_at` IS NULL OR NEW.`deleted_at` IS NULL OR NEW.`name` IS NOT '[erased]' OR NEW.`email` IS NOT NULL OR NEW.`phone` IS NOT ''
    OR NEW.`phone_verified_at` IS NOT NULL OR NEW.`email_verified_at` IS NOT NULL OR NEW.`last_authenticated_at` IS NOT NULL OR NEW.`tax_exemption_id` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_addresses_erased_owner_blocked`
BEFORE INSERT ON `customer_addresses`
WHEN EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_identities_erased_owner_blocked`
BEFORE INSERT ON `customer_identities`
WHEN EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_marketing_consents_erased_owner_blocked`
BEFORE INSERT ON `customer_marketing_consents`
WHEN EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_marketing_consent_events_erased_owner_blocked`
BEFORE INSERT ON `customer_marketing_consent_events`
WHEN EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
CREATE TRIGGER `customer_history_erased_owner_blocked`
BEFORE INSERT ON `customer_history`
WHEN (NEW.`name` IS NOT '[erased]' OR NEW.`email` IS NOT NULL OR NEW.`phone` IS NOT '')
  AND EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `erased_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMER_ERASED');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (191, '0191_erased_customers_frozen', '956e9c8f86d24b652b8ea4170ee9a6efa450a2cc22d002092c3359fb41a269d5');
