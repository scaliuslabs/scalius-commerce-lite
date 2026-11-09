-- How an app's payment method is paid (online, invoice, cash on delivery,
-- paid to the store), as its provider declared it when the order was placed:
-- analytics files the order by it after the app is gone. Null for the
-- platform's own methods, whose kind their id says.
ALTER TABLE `orders` ADD `payment_kind` text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (211, '0211_order_payment_kind', '71f77f85a515a29a13a3bdffa3c8119e0cfdd6b92f02ac2b1da2c02c4249cd07');
