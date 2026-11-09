-- The storefront presence an order was placed on (see the SQLite migration).
ALTER TABLE "orders" ADD COLUMN "presence" text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (206, '0206_order_presence', '05c20be68946ec9d39b9bd10f14a85a9e8556587a18ceb8eacf9f09bb48d0d69');
