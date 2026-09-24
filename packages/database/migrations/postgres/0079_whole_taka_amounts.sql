-- PostgreSQL sidecar of 0079_whole_taka_amounts: in a BDT store,
-- merchant-entered money is rounded half-up to whole taka; a non-zero amount
-- never becomes zero. Order, payment, refund and ledger rows stay as recorded.
UPDATE "products" SET
  "price_minor" = CASE WHEN "price_minor" > 0 THEN greatest(100, (("price_minor" + 50) / 100) * 100) ELSE "price_minor" END,
  "discount_amount_minor" = CASE WHEN "discount_amount_minor" > 0 THEN greatest(100, (("discount_amount_minor" + 50) / 100) * 100) ELSE "discount_amount_minor" END
WHERE (coalesce("price_minor", 0) % 100 <> 0 OR coalesce("discount_amount_minor", 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT "value"::jsonb ->> 'currencyCode' FROM "settings"
    WHERE "category" = 'currency' AND "key" = 'document' AND json_valid("value")
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE "product_variants" SET
  "price_minor" = CASE WHEN "price_minor" > 0 THEN greatest(100, (("price_minor" + 50) / 100) * 100) ELSE "price_minor" END,
  "discount_amount_minor" = CASE WHEN "discount_amount_minor" > 0 THEN greatest(100, (("discount_amount_minor" + 50) / 100) * 100) ELSE "discount_amount_minor" END
WHERE (coalesce("price_minor", 0) % 100 <> 0 OR coalesce("discount_amount_minor", 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT "value"::jsonb ->> 'currencyCode' FROM "settings"
    WHERE "category" = 'currency' AND "key" = 'document' AND json_valid("value")
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE "shipping_methods" SET
  "fee_minor" = CASE WHEN "fee_minor" > 0 THEN greatest(100, (("fee_minor" + 50) / 100) * 100) ELSE "fee_minor" END,
  "free_over_minor" = CASE WHEN "free_over_minor" > 0 THEN greatest(100, (("free_over_minor" + 50) / 100) * 100) ELSE "free_over_minor" END
WHERE (coalesce("fee_minor", 0) % 100 <> 0 OR coalesce("free_over_minor", 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT "value"::jsonb ->> 'currencyCode' FROM "settings"
    WHERE "category" = 'currency' AND "key" = 'document' AND json_valid("value")
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE "promotions" SET
  "max_discount_spend_minor" = CASE WHEN "max_discount_spend_minor" > 0 THEN greatest(100, (("max_discount_spend_minor" + 50) / 100) * 100) ELSE "max_discount_spend_minor" END
WHERE "budget_currency_code" = 'BDT' AND coalesce("max_discount_spend_minor", 0) % 100 <> 0;
--> statement-breakpoint
UPDATE "promotion_conditions" SET
  "config" = jsonb_set("config"::jsonb, '{amountMinor}', to_jsonb(CASE WHEN ("config"::jsonb #>> '{amountMinor}')::bigint > 0 THEN greatest(100, ((("config"::jsonb #>> '{amountMinor}')::bigint + 50) / 100) * 100) ELSE ("config"::jsonb #>> '{amountMinor}')::bigint END))::text
WHERE "kind" = 'minimum_merchandise_subtotal'
  AND "config"::jsonb #>> '{currencyCode}' = 'BDT'
  AND jsonb_typeof("config"::jsonb #> '{amountMinor}') = 'number'
  AND ("config"::jsonb #>> '{amountMinor}')::bigint % 100 <> 0;
--> statement-breakpoint
UPDATE "promotion_effects" SET
  "config" = jsonb_set("config"::jsonb, '{amountMinor}', to_jsonb(CASE WHEN ("config"::jsonb #>> '{amountMinor}')::bigint > 0 THEN greatest(100, ((("config"::jsonb #>> '{amountMinor}')::bigint + 50) / 100) * 100) ELSE ("config"::jsonb #>> '{amountMinor}')::bigint END))::text
WHERE "kind" = 'fixed_amount_off'
  AND "config"::jsonb #>> '{currencyCode}' = 'BDT'
  AND jsonb_typeof("config"::jsonb #> '{amountMinor}') = 'number'
  AND ("config"::jsonb #>> '{amountMinor}')::bigint % 100 <> 0;
--> statement-breakpoint
UPDATE "promotion_effects" SET
  "config" = jsonb_set("config"::jsonb, '{buy,amountMinor}', to_jsonb(CASE WHEN ("config"::jsonb #>> '{buy,amountMinor}')::bigint > 0 THEN greatest(100, ((("config"::jsonb #>> '{buy,amountMinor}')::bigint + 50) / 100) * 100) ELSE ("config"::jsonb #>> '{buy,amountMinor}')::bigint END))::text
WHERE "kind" = 'percentage_off'
  AND "config"::jsonb #>> '{buy,currencyCode}' = 'BDT'
  AND jsonb_typeof("config"::jsonb #> '{buy,amountMinor}') = 'number'
  AND ("config"::jsonb #>> '{buy,amountMinor}')::bigint % 100 <> 0;
--> statement-breakpoint
UPDATE "settings" SET
  "value" = jsonb_set("value"::jsonb, '{partialPaymentAmount}', to_jsonb(round(("value"::jsonb ->> 'partialPaymentAmount')::numeric)::bigint))::text,
  "revision" = "revision" + 1
WHERE "category" = 'checkout' AND "key" = 'document' AND json_valid("value")
  AND jsonb_typeof("value"::jsonb -> 'partialPaymentAmount') = 'number'
  AND ("value"::jsonb ->> 'partialPaymentAmount')::numeric <> round(("value"::jsonb ->> 'partialPaymentAmount')::numeric)
  AND coalesce(nullif(upper(trim((
    SELECT "value"::jsonb ->> 'currencyCode' FROM "settings"
    WHERE "category" = 'currency' AND "key" = 'document' AND json_valid("value")
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (79, '0079_whole_taka_amounts', 'a88163d1389ab6e37e1812c5d11a35bfdb01e692be58fbdf2c328bc6c5ee631c');
