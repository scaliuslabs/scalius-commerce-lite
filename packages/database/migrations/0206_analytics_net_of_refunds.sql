-- Sales figures are net of refunds: money given back with no goods returned
-- (a goodwill or price refund) now counts in returns, so net and total sales
-- drop by it (`orderReturnsText`). Measures derive on read from the facts, but
-- a sealed day's bucket rows were summed under the old rule: unseal every day
-- holding such an order, so readers take it from its facts and the sweep
-- reseals it.
DELETE FROM `analytics_sealed_days`
WHERE `day` IN (
  SELECT (CAST(`created_at` / 86400 AS INTEGER) - CASE WHEN `created_at` < 0 AND `created_at` <> CAST(`created_at` / 86400 AS INTEGER) * 86400 THEN 1 ELSE 0 END) * 86400
  FROM `analytics_order_facts`
  WHERE `refund_sum` > 0 AND `reversed` = 0
);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (206, '0206_analytics_net_of_refunds', '2ceb3a450e0591b4411b3b1df59db96fb75418d165f6f14bf75380d096c634a3');
