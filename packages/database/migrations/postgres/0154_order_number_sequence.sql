LOCK TABLE "orders" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS scalius_compat.order_number_seq AS bigint MINVALUE 1001 MAXVALUE 9007199254740991 START WITH 1001;
--> statement-breakpoint
SELECT setval('scalius_compat.order_number_seq', GREATEST(
    (SELECT coalesce(max("order_number"), 1000) + 1 FROM "orders"),
    (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM scalius_compat.order_number_seq)
  ), false);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (154, '0154_order_number_sequence', '417d5e9f53ea735a4d49aa74b85a3cbe3450c0c8e348808daa21689243552ac7');
