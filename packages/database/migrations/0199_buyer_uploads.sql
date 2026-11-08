-- Buyer uploads (COMMERCE-HOOKS H17): a file a buyer gives an app's `file`
-- line input or checkout attribute, stored privately in R2 under
-- `private/buyer-uploads/<id>`. A row is bound for good to its app, its input
-- and (a line input) its product; the order commit attaches it to one order
-- once. The guard refuses any change of what the upload is and any second
-- attach, and an attach names an order that exists and, for a line input, a
-- line of that order (for an attribute, none).
CREATE TABLE `buyer_uploads` (
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
	CONSTRAINT "buyer_uploads_id_shape" CHECK(substr("buyer_uploads"."id", 1, 4) = 'bup_' AND length("buyer_uploads"."id") = 28),
	CONSTRAINT "buyer_uploads_app_shape" CHECK(length("buyer_uploads"."app_id") BETWEEN 3 AND 100 AND substr("buyer_uploads"."field_key", 1, length("buyer_uploads"."app_id") + 1) = "buyer_uploads"."app_id" || '.' AND length("buyer_uploads"."field_key") <= 160),
	CONSTRAINT "buyer_uploads_target_check" CHECK("buyer_uploads"."target" IN ('line', 'attribute')),
	CONSTRAINT "buyer_uploads_target_product" CHECK(("buyer_uploads"."target" = 'line' AND "buyer_uploads"."product_id" IS NOT NULL) OR ("buyer_uploads"."target" = 'attribute' AND "buyer_uploads"."product_id" IS NULL)),
	CONSTRAINT "buyer_uploads_r2_key_private" CHECK("buyer_uploads"."r2_key" = 'private/buyer-uploads/' || "buyer_uploads"."id"),
	CONSTRAINT "buyer_uploads_media_type_check" CHECK("buyer_uploads"."media_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CONSTRAINT "buyer_uploads_size_bounds" CHECK("buyer_uploads"."size_bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "buyer_uploads_filename_length" CHECK(length("buyer_uploads"."filename") BETWEEN 1 AND 120),
	CONSTRAINT "buyer_uploads_sha256_shape" CHECK(length("buyer_uploads"."sha256") = 64),
	CONSTRAINT "buyer_uploads_uploader_key_shape" CHECK(length("buyer_uploads"."uploader_key") = 64),
	CONSTRAINT "buyer_uploads_attach_shape" CHECK(("buyer_uploads"."order_id" IS NULL AND "buyer_uploads"."order_item_id" IS NULL AND "buyer_uploads"."attached_at" IS NULL) OR ("buyer_uploads"."order_id" IS NOT NULL AND "buyer_uploads"."attached_at" IS NOT NULL AND ("buyer_uploads"."target" = 'line') = ("buyer_uploads"."order_item_id" IS NOT NULL)))
);
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
-- Erasure's storage work deletes buyer uploads too: its delete_file tasks
-- may name `private/buyer-uploads/` keys. SQLite cannot alter a CHECK, so
-- the small task table is rebuilt (no foreign key names it).
CREATE TABLE `__new_customer_erasure_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_id` text,
	`ref` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "customer_erasure_tasks_kind_check" CHECK("__new_customer_erasure_tasks"."kind" IN ('delete_file', 'detach_payment_method')),
	CONSTRAINT "customer_erasure_tasks_shape" CHECK(("__new_customer_erasure_tasks"."kind" = 'delete_file' AND "__new_customer_erasure_tasks"."provider_id" IS NULL AND (substr("__new_customer_erasure_tasks"."ref", 1, 22) = 'private/conversations/' OR substr("__new_customer_erasure_tasks"."ref", 1, 22) = 'private/buyer-uploads/')) OR ("__new_customer_erasure_tasks"."kind" = 'detach_payment_method' AND "__new_customer_erasure_tasks"."provider_id" IS NOT NULL AND length("__new_customer_erasure_tasks"."ref") >= 1)),
	CONSTRAINT "customer_erasure_tasks_attempts_check" CHECK("__new_customer_erasure_tasks"."attempts" >= 0),
	CONSTRAINT "customer_erasure_tasks_last_error_length" CHECK("__new_customer_erasure_tasks"."last_error" IS NULL OR length("__new_customer_erasure_tasks"."last_error") BETWEEN 1 AND 64)
);
--> statement-breakpoint
INSERT INTO `__new_customer_erasure_tasks`("id", "customer_id", "kind", "provider_id", "ref", "attempts", "next_attempt_at", "last_error", "created_at") SELECT "id", "customer_id", "kind", "provider_id", "ref", "attempts", "next_attempt_at", "last_error", "created_at" FROM `customer_erasure_tasks`;
--> statement-breakpoint
DROP TABLE `customer_erasure_tasks`;
--> statement-breakpoint
ALTER TABLE `__new_customer_erasure_tasks` RENAME TO `customer_erasure_tasks`;
--> statement-breakpoint
CREATE INDEX `customer_erasure_tasks_due_idx` ON `customer_erasure_tasks` (`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `customer_erasure_tasks_customer_idx` ON `customer_erasure_tasks` (`customer_id`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (199, '0199_buyer_uploads', '583194217250dc0a0bd89e912d439fbb00d851199a350771fd200dd99d97c230');
