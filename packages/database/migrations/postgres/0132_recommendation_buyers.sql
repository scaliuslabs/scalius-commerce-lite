CREATE INDEX IF NOT EXISTS "order_items_order_product_idx" ON "order_items" ("order_id","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_recommendation_buyers_idx" ON "orders" ("deleted_at","created_at","status","id","customer_phone","customer_email");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (132, '0132_recommendation_buyers', '09e8b41890bbf74b0a60309e229f58f5a50465e85959aac3e226b02b2c46ba64');
