CREATE INDEX IF NOT EXISTS `products_media_text_idx` ON `products` (`id`) WHERE instr(coalesce("products"."description", ''), 'media/') > 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (134, '0134_media_text_index', '5592fb3f544a55e9e6b6ac79f1b0c29095edba5c93a001813d096d171f19ca09');
