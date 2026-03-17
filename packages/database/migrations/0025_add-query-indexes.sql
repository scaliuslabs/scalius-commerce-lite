-- Migration 0025: Add missing query-performance indexes
--
-- 1. media.folder_id — JOIN on folder lookups
-- 2. media.deleted_at — soft-delete filtering
-- 3. delivery_providers.type — provider type filtering
-- 4. analytics.type — analytics type filtering
-- 5. product_attributes.slug — attribute slug lookups

CREATE INDEX IF NOT EXISTS media_folder_id_idx ON media(folder_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_deleted_at_idx ON media(deleted_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_providers_type_idx ON delivery_providers(type);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS analytics_type_idx ON analytics(type);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_attributes_slug_idx ON product_attributes(slug);
