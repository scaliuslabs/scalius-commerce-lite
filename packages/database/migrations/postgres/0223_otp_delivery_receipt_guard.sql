-- See ../0223_otp_delivery_receipt_guard.sql.
CREATE INDEX "auth_otp_delivery_receipts_expires_idx" ON "auth_otp_delivery_receipts" ("otp_expires_at");
--> statement-breakpoint
UPDATE "auth_otp_delivery_receipts" SET "status" = 'accepted' WHERE "status" IN ('delivered');
--> statement-breakpoint
UPDATE "auth_otp_delivery_receipts" SET "otp_expires_at" = "created_at" + 600 WHERE "otp_expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "auth_otp_delivery_receipts" DROP CONSTRAINT IF EXISTS "auth_otp_delivery_receipts_status_check", ADD CONSTRAINT "auth_otp_delivery_receipts_status_check" CHECK("auth_otp_delivery_receipts"."status" IN ('pending', 'processing', 'accepted', 'failed', 'skipped', 'expired'));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (223, '0223_otp_delivery_receipt_guard', '5c08d5eaef906c0b74b7519bcd4e085b59c11978cbbd23dc4d2bbe32311fcc42');
