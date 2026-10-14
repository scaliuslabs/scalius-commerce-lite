-- One facet engine on every provider: a scope counts its own products' facet
-- rows, and the plain shop-all page reads product_facet_public_counts. No
-- reader resolves facet metadata by kind any more, so these indexes only
-- cost every facet-row write.
DROP INDEX IF EXISTS `product_facet_values_metadata_label_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `product_facet_values_metadata_sort_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `product_facet_values_metadata_sample_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `product_facet_values_metadata_number_idx`;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (150, '0150_facet_engine', '8a8b3c43467345d999d1f9be32ad19346ef1bf584dd84c0438af2d6c84d87a60');
