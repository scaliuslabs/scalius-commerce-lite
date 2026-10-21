-- Tax-exempt buyers (audit I9). The merchant, or an app through
-- customers.update, marks a customer tax-exempt with an optional certificate
-- or registration number; their orders pay no tax (core tax/region-match.ts
-- `taxExemptionApplies`). Each order's tax snapshot records the exemption it
-- was priced with, so the invoice shows it after the customer changes.
-- Existing customers and orders are not exempt.
ALTER TABLE `customers` ADD `tax_exempt` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `customers` ADD `tax_exemption_id` text;
--> statement-breakpoint
ALTER TABLE `order_tax_snapshots` ADD `tax_exempt` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_tax_snapshots` ADD `tax_exemption_id` text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (178, '0178_tax_exempt_customers', 'd88cec1c207953eb4c6a8ea9b11ede2cad0dd173481d66ed21d5aadd98e8175d');
