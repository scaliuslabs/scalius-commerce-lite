-- The homepage "on sale" list reads only discounted rows, newest first,
-- instead of walking every product to find the few on sale. The WHERE of
-- each partial index is the list's own predicate, word for word.
CREATE INDEX `product_variants_on_sale_newest_idx` ON `product_variants` ("created_at" DESC) WHERE deleted_at IS NULL AND ((discount_type = 'flat' AND discount_amount_minor > 0) OR (discount_type = 'percentage' AND discount_bps > 0));
--> statement-breakpoint
CREATE INDEX `products_on_sale_newest_idx` ON `products` (`is_active`,`deleted_at`,"created_at" DESC,`id`) WHERE ((discount_type = 'flat' AND discount_amount_minor > 0) OR (discount_type = 'percentage' AND discount_bps > 0));
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (83, '0083_on_sale_indexes', '5b44f31ff08b9543d6818f86c0af8a6832456e35a274838e660dc6ae009e2795');
