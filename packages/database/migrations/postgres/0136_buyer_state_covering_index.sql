DROP INDEX IF EXISTS "product_buyer_state_price_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_buyer_state_price_idx" ON "product_buyer_state" ("is_public","from_minor","product_id","available_for_sale","category_id","product_created_at");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (136, '0136_buyer_state_covering_index', 'a37534e890574e9a2f21de767c61abb402209ff11d3003d8ce26cc40e2282494');
