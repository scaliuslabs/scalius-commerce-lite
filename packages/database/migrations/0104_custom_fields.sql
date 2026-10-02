-- Custom fields (COMMERCE-HOOKS H4, docs/platform/COMMERCE-HOOKS.md): typed
-- values on products, SKUs, customers, orders, categories, collections, brands
-- and pages. A definition is unique per (owner type, namespace, key); a value
-- is one canonical text per (definition, owner), validated by
-- @scalius/shared/custom-fields. The composite foreign key keeps a value's
-- owner type equal to its definition's and deletes values with their definition.
CREATE TABLE `custom_field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`validations` text DEFAULT '{}' NOT NULL,
	`storefront_visible` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "custom_field_definitions_id_shape" CHECK(substr("custom_field_definitions"."id", 1, 4) = 'cfd_' AND length("custom_field_definitions"."id") BETWEEN 10 AND 68 AND "custom_field_definitions"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "custom_field_definitions_owner_type_check" CHECK("owner_type" IN ('product', 'variant', 'customer', 'order', 'category', 'collection', 'brand', 'page')),
	CONSTRAINT "custom_field_definitions_namespace_shape" CHECK("custom_field_definitions"."namespace" = 'custom' OR (length("custom_field_definitions"."namespace") BETWEEN 3 AND 101 AND "custom_field_definitions"."namespace" NOT GLOB '*[^a-z0-9.-]*' AND instr("custom_field_definitions"."namespace", '.') > 1 AND instr("custom_field_definitions"."namespace", '.') < length("custom_field_definitions"."namespace") AND instr(substr("custom_field_definitions"."namespace", instr("custom_field_definitions"."namespace", '.') + 1), '.') = 0 AND substr("custom_field_definitions"."namespace", 1, 1) <> '-' AND substr("custom_field_definitions"."namespace", length("custom_field_definitions"."namespace"), 1) <> '-' AND instr("custom_field_definitions"."namespace", '-.') = 0 AND instr("custom_field_definitions"."namespace", '.-') = 0)),
	CONSTRAINT "custom_field_definitions_key_shape" CHECK(length("custom_field_definitions"."key") BETWEEN 2 AND 64 AND "custom_field_definitions"."key" NOT GLOB '*[^_a-z0-9]*' AND substr("custom_field_definitions"."key", 1, 1) GLOB '[a-z]'),
	CONSTRAINT "custom_field_definitions_name_valid" CHECK("custom_field_definitions"."name" = trim("custom_field_definitions"."name") AND length("custom_field_definitions"."name") BETWEEN 1 AND 80),
	CONSTRAINT "custom_field_definitions_description_length" CHECK("custom_field_definitions"."description" IS NULL OR length("custom_field_definitions"."description") <= 300),
	CONSTRAINT "custom_field_definitions_type_check" CHECK("type" IN ('single_line_text', 'multi_line_text', 'integer', 'decimal', 'boolean', 'date', 'date_time', 'url', 'color', 'json', 'money', 'product_reference', 'variant_reference', 'collection_reference', 'media_reference', 'list.single_line_text', 'list.multi_line_text', 'list.integer', 'list.decimal', 'list.date', 'list.date_time', 'list.url', 'list.color', 'list.money', 'list.product_reference', 'list.variant_reference', 'list.collection_reference', 'list.media_reference')),
	CONSTRAINT "custom_field_definitions_validations_json" CHECK(json_valid("custom_field_definitions"."validations") AND substr("custom_field_definitions"."validations", 1, 1) = '{'),
	CONSTRAINT "custom_field_definitions_storefront_owner" CHECK("custom_field_definitions"."storefront_visible" = 0 OR ("custom_field_definitions"."storefront_visible" = 1 AND "custom_field_definitions"."owner_type" NOT IN ('customer', 'order'))),
	CONSTRAINT "custom_field_definitions_revision_positive" CHECK("custom_field_definitions"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_definitions_owner_key_unique` ON `custom_field_definitions` (`owner_type`,`namespace`,`key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_definitions_id_owner_unique` ON `custom_field_definitions` (`id`,`owner_type`);
--> statement-breakpoint
CREATE INDEX `custom_field_definitions_owner_position_idx` ON `custom_field_definitions` (`owner_type`,`position`);
--> statement-breakpoint
CREATE TABLE `custom_field_values` (
	`definition_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`definition_id`, `owner_id`),
	FOREIGN KEY (`definition_id`,`owner_type`) REFERENCES `custom_field_definitions`(`id`,`owner_type`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "custom_field_values_owner_type_check" CHECK("owner_type" IN ('product', 'variant', 'customer', 'order', 'category', 'collection', 'brand', 'page')),
	CONSTRAINT "custom_field_values_owner_id_length" CHECK(length("custom_field_values"."owner_id") BETWEEN 1 AND 128),
	CONSTRAINT "custom_field_values_value_length" CHECK(length("custom_field_values"."value") BETWEEN 1 AND 65536)
);
--> statement-breakpoint
CREATE INDEX `custom_field_values_owner_idx` ON `custom_field_values` (`owner_type`,`owner_id`);
--> statement-breakpoint
-- >>> H4 custom fields: owner cleanup and cache dependency triggers
-- Deleting an owner row (a permanent delete; trash keeps values) deletes its
-- values. One statement per body, guard-free: remote D1 accepts it.
CREATE TRIGGER `cfv_products_cleanup` AFTER DELETE ON `products`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'product' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_product_variants_cleanup` AFTER DELETE ON `product_variants`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'variant' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_customers_cleanup` AFTER DELETE ON `customers`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'customer' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_orders_cleanup` AFTER DELETE ON `orders`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'order' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_categories_cleanup` AFTER DELETE ON `categories`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'category' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_collections_cleanup` AFTER DELETE ON `collections`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'collection' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_brands_cleanup` AFTER DELETE ON `brands`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'brand' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cfv_pages_cleanup` AFTER DELETE ON `pages`
BEGIN
  DELETE FROM `custom_field_values` WHERE `owner_type` = 'page' AND `owner_id` = OLD.`id`;
END;
--> statement-breakpoint
-- Cache dependencies (packages/shared/src/cache-deps.ts, generated by
-- packages/database/scripts/cache-dep-triggers.ts): a storefront-visible
-- value advances its owner's keys; a visible definition advances cf:<owner_type>.
CREATE TRIGGER `cdep_custom_field_definitions_ins` AFTER INSERT ON `custom_field_definitions`
WHEN NEW.`storefront_visible` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('cf:' || NEW.`owner_type`, 't:custom_field_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_definitions_del` AFTER DELETE ON `custom_field_definitions`
WHEN OLD.`storefront_visible` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('cf:' || OLD.`owner_type`, 't:custom_field_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_definitions_upd` AFTER UPDATE ON `custom_field_definitions`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`namespace` IS NOT NEW.`namespace` OR OLD.`key` IS NOT NEW.`key` OR OLD.`name` IS NOT NEW.`name` OR OLD.`type` IS NOT NEW.`type` OR OLD.`storefront_visible` IS NOT NEW.`storefront_visible` OR OLD.`position` IS NOT NEW.`position`)
  AND NEW.`storefront_visible` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('cf:' || NEW.`owner_type`, 't:custom_field_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_definitions_upd_old` AFTER UPDATE ON `custom_field_definitions`
WHEN (OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`storefront_visible` IS NOT NEW.`storefront_visible`)
  AND OLD.`storefront_visible` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('cf:' || OLD.`owner_type`, 't:custom_field_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_product_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'product'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`owner_id`, 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_product_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'product'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`owner_id`, 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_product_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'product'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`owner_id`, 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_product_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'product'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`owner_id`, 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_variant_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'variant'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`owner_id`), 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_variant_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'variant'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`owner_id`), 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_variant_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'variant'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`owner_id`), 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_variant_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'variant'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`owner_id`), 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_category_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'category'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('c:' || NEW.`owner_id`, 'c:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_category_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'category'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('c:' || OLD.`owner_id`, 'c:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_category_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'category'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('c:' || NEW.`owner_id`, 'c:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_category_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'category'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('c:' || OLD.`owner_id`, 'c:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_collection_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'collection'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('col:' || NEW.`owner_id`, 'col:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_collection_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'collection'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('col:' || OLD.`owner_id`, 'col:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_collection_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'collection'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('col:' || NEW.`owner_id`, 'col:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_collection_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'collection'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('col:' || OLD.`owner_id`, 'col:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_brand_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'brand'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('b:' || NEW.`owner_id`, 'b:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_brand_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'brand'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('b:' || OLD.`owner_id`, 'b:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_brand_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'brand'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('b:' || NEW.`owner_id`, 'b:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_brand_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'brand'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('b:' || OLD.`owner_id`, 'b:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_page_ins` AFTER INSERT ON `custom_field_values`
WHEN NEW.`owner_type` = 'page'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pg:' || NEW.`owner_id`, 'pg:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_page_del` AFTER DELETE ON `custom_field_values`
WHEN OLD.`owner_type` = 'page'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pg:' || OLD.`owner_id`, 'pg:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_page_upd` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`value` IS NOT NEW.`value`)
  AND NEW.`owner_type` = 'page'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = NEW.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pg:' || NEW.`owner_id`, 'pg:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_custom_field_values_page_upd_old` AFTER UPDATE ON `custom_field_values`
WHEN (OLD.`owner_id` IS NOT NEW.`owner_id` OR OLD.`owner_type` IS NOT NEW.`owner_type` OR OLD.`definition_id` IS NOT NEW.`definition_id`)
  AND OLD.`owner_type` = 'page'
  AND EXISTS (SELECT 1 FROM custom_field_definitions AS cf_definition WHERE cf_definition.id = OLD.definition_id AND cf_definition.storefront_visible = 1)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pg:' || OLD.`owner_id`, 'pg:*', 't:custom_field_values')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
-- <<< H4
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (104, '0104_custom_fields', 'cd82986061df2a502c2140d43e2d817cee190f26052352825b2751d910e9b2b1');
