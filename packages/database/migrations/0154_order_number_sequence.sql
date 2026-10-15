-- PostgreSQL allocates order numbers from a native sequence, initialized above
-- every historical order during upgrade/import. SQLite retains MAX + 1 inside
-- the order INSERT. Both retain the unique orders.order_number index.
SELECT 1;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (154, '0154_order_number_sequence', '417d5e9f53ea735a4d49aa74b85a3cbe3450c0c8e348808daa21689243552ac7');
