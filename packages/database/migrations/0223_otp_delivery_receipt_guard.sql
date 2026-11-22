-- Sign-in code delivery receipts end and expire
-- (rules/auth/otp-delivery-receipt-ends-and-expires.md): the status refuses
-- any value its code does not declare (two guard triggers that write no row;
-- a CHECK on PostgreSQL), after `delivered`, declared but never written, is
-- mapped to `accepted`. Every receipt gets its code's expiry (one written
-- without it ends ten minutes after it was made), indexed for the sweep that
-- ends and deletes them. Only rows that need it are written; no table is rebuilt.
CREATE INDEX `auth_otp_delivery_receipts_expires_idx` ON `auth_otp_delivery_receipts` (`otp_expires_at`);
--> statement-breakpoint
UPDATE `auth_otp_delivery_receipts` SET `status` = 'accepted' WHERE `status` IN ('delivered');
--> statement-breakpoint
UPDATE `auth_otp_delivery_receipts` SET `otp_expires_at` = `created_at` + 600 WHERE `otp_expires_at` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `auth_otp_delivery_receipts_status_insert_guard`
BEFORE INSERT ON `auth_otp_delivery_receipts`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'accepted', 'failed', 'skipped', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'auth_otp_delivery_receipts_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_otp_delivery_receipts_status_update_guard`
BEFORE UPDATE OF `status` ON `auth_otp_delivery_receipts`
WHEN NEW.`status` NOT IN ('pending', 'processing', 'accepted', 'failed', 'skipped', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'auth_otp_delivery_receipts_status_check');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (223, '0223_otp_delivery_receipt_guard', '5c08d5eaef906c0b74b7519bcd4e085b59c11978cbbd23dc4d2bbe32311fcc42');
