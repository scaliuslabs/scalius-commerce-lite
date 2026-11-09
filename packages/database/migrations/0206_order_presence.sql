-- The storefront presence an order was placed on (`bn`, `en-in`; null at the
-- root and off the storefront), so the buyer's emails and SMS speak its
-- language and link into it.
ALTER TABLE `orders` ADD `presence` text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (206, '0206_order_presence', '05c20be68946ec9d39b9bd10f14a85a9e8556587a18ceb8eacf9f09bb48d0d69');
