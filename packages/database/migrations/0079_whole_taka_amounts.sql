-- Taka amounts are whole numbers. In a BDT store, merchant-entered money
-- (catalog prices and flat discounts, delivery charges and free-over
-- thresholds, fixed discount amounts, minimums and budgets, and the online
-- advance) is rounded half-up to whole taka; a non-zero amount never becomes
-- zero. Order, payment, refund and ledger rows are receipts of what was
-- charged and stay exactly as recorded. Other currencies are unchanged.
UPDATE `products` SET
  `price_minor` = CASE WHEN `price_minor` > 0 THEN max(100, ((`price_minor` + 50) / 100) * 100) ELSE `price_minor` END,
  `discount_amount_minor` = CASE WHEN `discount_amount_minor` > 0 THEN max(100, ((`discount_amount_minor` + 50) / 100) * 100) ELSE `discount_amount_minor` END
WHERE (coalesce(`price_minor`, 0) % 100 <> 0 OR coalesce(`discount_amount_minor`, 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT json_extract(`value`, '$.currencyCode') FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`)
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE `product_variants` SET
  `price_minor` = CASE WHEN `price_minor` > 0 THEN max(100, ((`price_minor` + 50) / 100) * 100) ELSE `price_minor` END,
  `discount_amount_minor` = CASE WHEN `discount_amount_minor` > 0 THEN max(100, ((`discount_amount_minor` + 50) / 100) * 100) ELSE `discount_amount_minor` END
WHERE (coalesce(`price_minor`, 0) % 100 <> 0 OR coalesce(`discount_amount_minor`, 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT json_extract(`value`, '$.currencyCode') FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`)
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE `shipping_methods` SET
  `fee_minor` = CASE WHEN `fee_minor` > 0 THEN max(100, ((`fee_minor` + 50) / 100) * 100) ELSE `fee_minor` END,
  `free_over_minor` = CASE WHEN `free_over_minor` > 0 THEN max(100, ((`free_over_minor` + 50) / 100) * 100) ELSE `free_over_minor` END
WHERE (coalesce(`fee_minor`, 0) % 100 <> 0 OR coalesce(`free_over_minor`, 0) % 100 <> 0)
  AND coalesce(nullif(upper(trim((
    SELECT json_extract(`value`, '$.currencyCode') FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`)
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
UPDATE `promotions` SET
  `max_discount_spend_minor` = CASE WHEN `max_discount_spend_minor` > 0 THEN max(100, ((`max_discount_spend_minor` + 50) / 100) * 100) ELSE `max_discount_spend_minor` END
WHERE `budget_currency_code` = 'BDT' AND coalesce(`max_discount_spend_minor`, 0) % 100 <> 0;
--> statement-breakpoint
UPDATE `promotion_conditions` SET
  `config` = json_set(`config`, '$.amountMinor', CASE WHEN json_extract(`config`, '$.amountMinor') > 0 THEN max(100, ((json_extract(`config`, '$.amountMinor') + 50) / 100) * 100) ELSE json_extract(`config`, '$.amountMinor') END)
WHERE `kind` = 'minimum_merchandise_subtotal'
  AND json_extract(`config`, '$.currencyCode') = 'BDT'
  AND json_type(`config`, '$.amountMinor') = 'integer'
  AND json_extract(`config`, '$.amountMinor') % 100 <> 0;
--> statement-breakpoint
UPDATE `promotion_effects` SET
  `config` = json_set(`config`, '$.amountMinor', CASE WHEN json_extract(`config`, '$.amountMinor') > 0 THEN max(100, ((json_extract(`config`, '$.amountMinor') + 50) / 100) * 100) ELSE json_extract(`config`, '$.amountMinor') END)
WHERE `kind` = 'fixed_amount_off'
  AND json_extract(`config`, '$.currencyCode') = 'BDT'
  AND json_type(`config`, '$.amountMinor') = 'integer'
  AND json_extract(`config`, '$.amountMinor') % 100 <> 0;
--> statement-breakpoint
UPDATE `promotion_effects` SET
  `config` = json_set(`config`, '$.buy.amountMinor', CASE WHEN json_extract(`config`, '$.buy.amountMinor') > 0 THEN max(100, ((json_extract(`config`, '$.buy.amountMinor') + 50) / 100) * 100) ELSE json_extract(`config`, '$.buy.amountMinor') END)
WHERE `kind` = 'percentage_off'
  AND json_extract(`config`, '$.buy.currencyCode') = 'BDT'
  AND json_type(`config`, '$.buy.amountMinor') = 'integer'
  AND json_extract(`config`, '$.buy.amountMinor') % 100 <> 0;
--> statement-breakpoint
UPDATE `settings` SET
  `value` = json_set(`value`, '$.partialPaymentAmount', CAST(round(json_extract(`value`, '$.partialPaymentAmount')) AS integer)),
  `revision` = `revision` + 1
WHERE `category` = 'checkout' AND `key` = 'document' AND json_valid(`value`)
  AND json_type(`value`, '$.partialPaymentAmount') = 'real'
  AND coalesce(nullif(upper(trim((
    SELECT json_extract(`value`, '$.currencyCode') FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`)
    LIMIT 1
  ))), ''), 'BDT') = 'BDT';
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (79, '0079_whole_taka_amounts', 'a88163d1389ab6e37e1812c5d11a35bfdb01e692be58fbdf2c328bc6c5ee631c');
