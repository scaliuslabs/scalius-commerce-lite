-- Phone optional for digital and service orders (owner decision 2026-10-07).
-- A contact without a phone is stored as '' (NO_PHONE in
-- @scalius/shared/customer-auth-policy) in the NOT NULL phone columns; no
-- table is rebuilt. The one-guest-record-per-phone rule now skips those
-- records, and a phoneless guest record is keyed by its email instead, as
-- Shopify keys guests. Indexes only.
DROP INDEX "customers_guest_phone_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_guest_phone_unique" ON "customers" ("phone") WHERE "account_claimed_at" IS NULL AND "deleted_at" IS NULL AND "phone" <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_guest_email_unique" ON "customers" (lower("email")) WHERE "phone" = '' AND "account_claimed_at" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (117, '0117_phoneless_guest_customers', '338a5618e830be7296da04d94e3c574293dfa849d917258fa64d5fe589cdbd6e');
