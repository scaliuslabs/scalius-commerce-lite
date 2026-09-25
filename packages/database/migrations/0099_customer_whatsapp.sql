-- Customer accounts can collect a separate WhatsApp number at checkout. It
-- is where WhatsApp codes for the order go; null means the order's phone.
-- Expand-only: a nullable column the previous API never writes.
ALTER TABLE `orders` ADD `customer_whatsapp` text;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (99, '0099_customer_whatsapp', '50e207ecaf45d21cf0b12fad93cd0a7ac24f8e3b8e1b21d8255ca9be3cf31ecf');
