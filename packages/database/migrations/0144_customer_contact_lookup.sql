CREATE INDEX IF NOT EXISTS `orders_customer_phone_lookup_idx` ON `orders` (`customer_phone`,`deleted_at`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_customer_email_lookup_idx` ON `orders` (lower(trim("customer_email")),`deleted_at`,`created_at`,`id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_customer_phone_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `orders_customer_email_normalized_idx`;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (144, '0144_customer_contact_lookup', 'af1d0f484acdf26802798a42068b659a70e4d8d667db2eed7476432e1968daa7');
