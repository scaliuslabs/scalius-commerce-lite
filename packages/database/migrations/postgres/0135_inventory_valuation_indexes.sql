DROP INDEX IF EXISTS "inventory_levels_location_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_levels_positive_variant_idx" ON "inventory_levels" ("variant_id") WHERE "inventory_levels"."on_hand" > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_levels_location_idx" ON "inventory_levels" ("location_id","on_hand","variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_valuation_cost_idx" ON "product_variants" ("id","cost_minor");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (135, '0135_inventory_valuation_indexes', '2b1d6f6b768585f73744123210b8e65da0e2cb86ecb80cf0c7f0dd14208fc212');
