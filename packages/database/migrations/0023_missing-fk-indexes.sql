-- Migration 0023: Add missing FK indexes for query performance
--
-- These indexes cover foreign-key columns that were missing indexes,
-- improving JOIN and lookup performance.

CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(phone);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_locations_parent_id_idx ON delivery_locations(parent_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discount_collections_collection_id_idx ON discount_collections(collection_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_items_variant_id_idx ON order_items(variant_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discount_products_discount_id_idx ON discount_products(discount_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discount_products_product_id_idx ON discount_products(product_id);
