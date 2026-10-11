CREATE INDEX IF NOT EXISTS `orders_recommendation_id_buyers_idx` ON `orders` (`id`,`deleted_at`,`status`,`created_at`,`customer_phone`,`customer_email`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (137, '0137_recommendation_order_id', '6ff4dc3443b5a6107534f6cedc89a91afba4379b5d89d80145bb51603064907a');
