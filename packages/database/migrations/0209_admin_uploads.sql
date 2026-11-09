-- Admin uploads (COMMERCE-HOOKS H17): staff give a file to one of an app's
-- admin forms (a `file-field`, e.g. a CSV import), kept in the buyer-uploads
-- store: target `admin`, bound to its app and admin route, never attached
-- to an order, typed `text/csv` from its bytes, read only by its app and
-- deleted by the app or by the 72-hour sweep. SQLite cannot alter a CHECK,
-- so the table is rebuilt (no foreign key names it); its indexes and the
-- identity guard are recreated as 0201 made them.
CREATE TABLE `__new_buyer_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`field_key` text NOT NULL,
	`target` text NOT NULL,
	`product_id` text,
	`r2_key` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`uploader_key` text NOT NULL,
	`order_id` text,
	`order_item_id` text,
	`attached_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "buyer_uploads_id_shape" CHECK(substr("__new_buyer_uploads"."id", 1, 4) = 'bup_' AND length("__new_buyer_uploads"."id") = 28),
	CONSTRAINT "buyer_uploads_app_shape" CHECK(length("__new_buyer_uploads"."app_id") BETWEEN 3 AND 100 AND substr("__new_buyer_uploads"."field_key", 1, length("__new_buyer_uploads"."app_id") + 1) = "__new_buyer_uploads"."app_id" || '.' AND length("__new_buyer_uploads"."field_key") <= 160),
	CONSTRAINT "buyer_uploads_target_check" CHECK("__new_buyer_uploads"."target" IN ('line', 'attribute', 'admin')),
	CONSTRAINT "buyer_uploads_target_product" CHECK(("__new_buyer_uploads"."target" = 'line' AND "__new_buyer_uploads"."product_id" IS NOT NULL) OR ("__new_buyer_uploads"."target" IN ('attribute', 'admin') AND "__new_buyer_uploads"."product_id" IS NULL)),
	CONSTRAINT "buyer_uploads_r2_key_private" CHECK("__new_buyer_uploads"."r2_key" = 'private/buyer-uploads/' || "__new_buyer_uploads"."id"),
	CONSTRAINT "buyer_uploads_media_type_check" CHECK("__new_buyer_uploads"."media_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv')),
	CONSTRAINT "buyer_uploads_size_bounds" CHECK("__new_buyer_uploads"."size_bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "buyer_uploads_filename_length" CHECK(length("__new_buyer_uploads"."filename") BETWEEN 1 AND 120),
	CONSTRAINT "buyer_uploads_sha256_shape" CHECK(length("__new_buyer_uploads"."sha256") = 64),
	CONSTRAINT "buyer_uploads_uploader_key_shape" CHECK(length("__new_buyer_uploads"."uploader_key") = 64),
	CONSTRAINT "buyer_uploads_attach_shape" CHECK(("__new_buyer_uploads"."order_id" IS NULL AND "__new_buyer_uploads"."order_item_id" IS NULL AND "__new_buyer_uploads"."attached_at" IS NULL) OR ("__new_buyer_uploads"."order_id" IS NOT NULL AND "__new_buyer_uploads"."attached_at" IS NOT NULL AND "__new_buyer_uploads"."target" <> 'admin' AND ("__new_buyer_uploads"."target" = 'line') = ("__new_buyer_uploads"."order_item_id" IS NOT NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_buyer_uploads`("id", "app_id", "field_key", "target", "product_id", "r2_key", "media_type", "size_bytes", "filename", "sha256", "uploader_key", "order_id", "order_item_id", "attached_at", "created_at") SELECT "id", "app_id", "field_key", "target", "product_id", "r2_key", "media_type", "size_bytes", "filename", "sha256", "uploader_key", "order_id", "order_item_id", "attached_at", "created_at" FROM `buyer_uploads`;
--> statement-breakpoint
DROP TABLE `buyer_uploads`;
--> statement-breakpoint
ALTER TABLE `__new_buyer_uploads` RENAME TO `buyer_uploads`;
--> statement-breakpoint
CREATE INDEX `buyer_uploads_orphan_idx` ON `buyer_uploads` (`created_at`) WHERE "buyer_uploads"."order_id" IS NULL;
--> statement-breakpoint
CREATE INDEX `buyer_uploads_uploader_idx` ON `buyer_uploads` (`uploader_key`,`created_at`) WHERE "buyer_uploads"."order_id" IS NULL;
--> statement-breakpoint
CREATE INDEX `buyer_uploads_order_idx` ON `buyer_uploads` (`order_id`,`id`) WHERE "buyer_uploads"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `buyer_uploads_retention_idx` ON `buyer_uploads` (`attached_at`) WHERE "buyer_uploads"."attached_at" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `buyer_uploads_identity_guard`
BEFORE UPDATE ON `buyer_uploads`
WHEN NEW.`id` IS NOT OLD.`id`
  OR NEW.`app_id` IS NOT OLD.`app_id`
  OR NEW.`field_key` IS NOT OLD.`field_key`
  OR NEW.`target` IS NOT OLD.`target`
  OR NEW.`product_id` IS NOT OLD.`product_id`
  OR NEW.`r2_key` IS NOT OLD.`r2_key`
  OR NEW.`media_type` IS NOT OLD.`media_type`
  OR NEW.`size_bytes` IS NOT OLD.`size_bytes`
  OR NEW.`filename` IS NOT OLD.`filename`
  OR NEW.`sha256` IS NOT OLD.`sha256`
  OR NEW.`uploader_key` IS NOT OLD.`uploader_key`
  OR NEW.`created_at` IS NOT OLD.`created_at`
  OR (OLD.`order_id` IS NOT NULL AND (
    NEW.`order_id` IS NOT OLD.`order_id`
    OR NEW.`order_item_id` IS NOT OLD.`order_item_id`
    OR NEW.`attached_at` IS NOT OLD.`attached_at`
  ))
  OR (OLD.`order_id` IS NULL AND NEW.`order_id` IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM `orders` WHERE `orders`.`id` = NEW.`order_id`)
    OR (NEW.`order_item_id` IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM `order_items` WHERE `order_items`.`id` = NEW.`order_item_id` AND `order_items`.`order_id` = NEW.`order_id`
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'buyer_upload_immutable');
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (209, '0209_admin_uploads', 'c75cc8d70bde716f0ed3ff2ad77a2981c9b9df7403c4cc1e7799a2e7c657ba4f');
