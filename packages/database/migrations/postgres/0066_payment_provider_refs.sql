-- DRAFT (payment gateway port): the lead regenerates the migration hash.
ALTER TABLE "order_payments" ADD COLUMN "provider_ref" text;
--> statement-breakpoint
ALTER TABLE "order_payments" ADD COLUMN "provider_secondary_ref" text;
--> statement-breakpoint
UPDATE "order_payments"
SET "provider_secondary_ref" = CASE "payment_method"
    WHEN 'stripe' THEN "stripe_charge_id"
    ELSE "sslcommerz_bank_tran_id"
  END,
  "metadata" = CASE
    WHEN "payment_method" <> 'sslcommerz' OR "sslcommerz_tran_id" IS NULL THEN "metadata"
    WHEN "metadata" IS NULL THEN jsonb_build_object('tranId', "sslcommerz_tran_id")::text
    WHEN "metadata" LIKE '{%' THEN ("metadata"::jsonb || jsonb_build_object('tranId', "sslcommerz_tran_id"))::text
    ELSE "metadata"
  END
WHERE "payment_method" IN ('stripe', 'sslcommerz') AND "payment_type" <> 'refund';
--> statement-breakpoint
UPDATE "order_payments" AS target
SET "provider_ref" = CASE target."payment_method" WHEN 'stripe' THEN target."stripe_payment_intent_id" ELSE target."sslcommerz_val_id" END
WHERE target."payment_method" IN ('stripe', 'sslcommerz')
  AND target."payment_type" <> 'refund'
  AND target."id" = (
    SELECT p."id" FROM "order_payments" p
    WHERE p."payment_method" = target."payment_method"
      AND p."payment_type" <> 'refund'
      AND (
        (p."payment_method" = 'stripe' AND p."stripe_payment_intent_id" = target."stripe_payment_intent_id")
        OR (p."payment_method" = 'sslcommerz' AND p."sslcommerz_val_id" = target."sslcommerz_val_id")
      )
    ORDER BY CASE p."status" WHEN 'succeeded' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, p."created_at" DESC, p."id"
    LIMIT 1
  );
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_order_payments_stripe_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_order_payments_sslcommerz_val_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "order_payments_stripe_pi_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "order_payments_ssl_tran_idx";
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN IF EXISTS "stripe_payment_intent_id";
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN IF EXISTS "stripe_charge_id";
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN IF EXISTS "sslcommerz_tran_id";
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN IF EXISTS "sslcommerz_val_id";
--> statement-breakpoint
ALTER TABLE "order_payments" DROP COLUMN IF EXISTS "sslcommerz_bank_tran_id";
--> statement-breakpoint
CREATE UNIQUE INDEX "order_payments_provider_ref_unique" ON "order_payments" ("payment_method","provider_ref") WHERE "order_payments"."provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "order_payments_provider_secondary_ref_idx" ON "order_payments" ("payment_method","provider_secondary_ref");
--> statement-breakpoint
UPDATE "webhook_events"
SET "event_type" = 'refund.observed',
  "result" = ("result"::jsonb || jsonb_build_object(
    'providerRef', "result"::jsonb ->> 'paymentIntentId',
    'secondaryRef', "result"::jsonb ->> 'chargeId'
  ))::text
WHERE "provider" = 'stripe' AND "event_type" = 'charge.refunded' AND "status" = 'manual_reconciliation' AND "result" LIKE '{%';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (66, '0066_payment_provider_refs', '49f766711be807af246f7a7c6c5ac1984dff6b49000ab73fce487f53d902d3b7');
