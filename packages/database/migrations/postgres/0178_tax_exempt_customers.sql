ALTER TABLE "customers" ADD COLUMN "tax_exempt" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_exemption_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "order_tax_snapshots" ADD COLUMN "tax_exempt" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_tax_snapshots" ADD COLUMN "tax_exemption_id" text COLLATE "C";
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (178, '0178_tax_exempt_customers', 'd88cec1c207953eb4c6a8ea9b11ede2cad0dd173481d66ed21d5aadd98e8175d');
