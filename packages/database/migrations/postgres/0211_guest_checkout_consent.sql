-- Guest consent from an unsubmitted checkout (COMMERCE-HOOKS H20): see
-- ../0211_guest_checkout_consent.sql. A new consent source, the checkout
-- session that gave it and when its one cart reminder was claimed.
ALTER TABLE "customer_marketing_consents" ADD COLUMN "checkout_session_id" text;
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" ADD COLUMN "reminder_sent_at" bigint;
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" DROP CONSTRAINT "customer_marketing_consents_source_check";
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" ADD CONSTRAINT "customer_marketing_consents_source_check" CHECK("customer_marketing_consents"."source" IN ('checkout', 'account', 'newsletter', 'admin', 'import', 'plugin', 'link', 'unsubmitted_checkout'));
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" ADD CONSTRAINT "customer_marketing_consents_checkout_shape" CHECK(("customer_marketing_consents"."source" = 'unsubmitted_checkout') = ("customer_marketing_consents"."checkout_session_id" IS NOT NULL) OR "customer_marketing_consents"."state" = 'unsubscribed');
--> statement-breakpoint
CREATE INDEX "customer_marketing_consents_checkout_idx" ON "customer_marketing_consents" ("checkout_session_id") WHERE "customer_marketing_consents"."checkout_session_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (211, '0211_guest_checkout_consent', 'c31089b2cc7c0b3c0c0f1e5c8377f133b0fcd6ffc85f09af606b2e9709f46fad');
