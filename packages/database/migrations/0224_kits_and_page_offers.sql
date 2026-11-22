-- Kits and the offers on a product page (rules/catalog/kits-sell-as-components.md).
-- A kit is a SKU made of other SKUs: `variant_components` lists its 1 to 20
-- components and their quantities. Guard triggers keep every kit legal: each
-- component a live SKU when added, never the kit itself (CHECK), never a kit
-- inside a kit, never a gift card, at most 20, and a kit holds no stock of its
-- own and never gets a stock movement (its components do). A component
-- deleted later keeps its row, so the kit reads unavailable and says why.
-- `product_page_offers` is the ordered list of other products' SKUs a
-- product page shows under its own. Both tables are new: nothing is rebuilt.
CREATE TABLE `product_page_offers` (
	`product_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`product_id`, `variant_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_page_offers_position_range" CHECK("product_page_offers"."position" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE INDEX `product_page_offers_variant_idx` ON `product_page_offers` (`variant_id`);
--> statement-breakpoint
CREATE TABLE `variant_components` (
	`kit_variant_id` text NOT NULL,
	`component_variant_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`kit_variant_id`, `component_variant_id`),
	FOREIGN KEY (`kit_variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "variant_components_quantity_range" CHECK("variant_components"."quantity" BETWEEN 1 AND 100),
	CONSTRAINT "variant_components_not_self" CHECK("variant_components"."kit_variant_id" <> "variant_components"."component_variant_id"),
	CONSTRAINT "variant_components_position_range" CHECK("variant_components"."position" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE INDEX `variant_components_component_idx` ON `variant_components` (`component_variant_id`);
--> statement-breakpoint
CREATE TRIGGER `variant_components_component_live`
BEFORE INSERT ON `variant_components`
WHEN NOT EXISTS (SELECT 1 FROM `product_variants` AS component_sku WHERE component_sku.`id` = NEW.`component_variant_id` AND component_sku.`deleted_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'variant_components_component_missing');
END;
--> statement-breakpoint
CREATE TRIGGER `variant_components_not_nested`
BEFORE INSERT ON `variant_components`
WHEN EXISTS (SELECT 1 FROM `variant_components` AS existing WHERE existing.`kit_variant_id` = NEW.`component_variant_id`)
  OR EXISTS (SELECT 1 FROM `variant_components` AS existing WHERE existing.`component_variant_id` = NEW.`kit_variant_id`)
BEGIN
  SELECT RAISE(ABORT, 'variant_components_nested');
END;
--> statement-breakpoint
CREATE TRIGGER `variant_components_no_gift_card`
BEFORE INSERT ON `variant_components`
WHEN EXISTS (
  SELECT 1 FROM `product_variants` AS kit_sku
  INNER JOIN `products` AS kit_product ON kit_product.`id` = kit_sku.`product_id`
  WHERE kit_sku.`id` IN (NEW.`kit_variant_id`, NEW.`component_variant_id`) AND kit_product.`is_gift_card` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'variant_components_gift_card');
END;
--> statement-breakpoint
CREATE TRIGGER `variant_components_limit`
BEFORE INSERT ON `variant_components`
WHEN (SELECT count(*) FROM `variant_components` AS existing WHERE existing.`kit_variant_id` = NEW.`kit_variant_id`) >= 20
BEGIN
  SELECT RAISE(ABORT, 'variant_components_limit');
END;
--> statement-breakpoint
CREATE TRIGGER `variant_components_kit_holds_no_stock`
BEFORE INSERT ON `variant_components`
WHEN EXISTS (
  SELECT 1 FROM `product_variants` AS kit_sku
  WHERE kit_sku.`id` = NEW.`kit_variant_id` AND (kit_sku.`stock` <> 0 OR kit_sku.`reserved_stock` <> 0 OR kit_sku.`preorder_stock` <> 0)
)
BEGIN
  SELECT RAISE(ABORT, 'variant_components_kit_stock');
END;
--> statement-breakpoint
CREATE TRIGGER `variant_components_identity_immutable`
BEFORE UPDATE OF `kit_variant_id`, `component_variant_id` ON `variant_components`
WHEN NEW.`kit_variant_id` IS NOT OLD.`kit_variant_id` OR NEW.`component_variant_id` IS NOT OLD.`component_variant_id`
BEGIN
  SELECT RAISE(ABORT, 'variant_components_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_movements_never_a_kit`
BEFORE INSERT ON `inventory_movements`
WHEN EXISTS (SELECT 1 FROM `variant_components` AS kit_part WHERE kit_part.`kit_variant_id` = NEW.`variant_id`)
BEGIN
  SELECT RAISE(ABORT, 'inventory_movements_kit');
END;
--> statement-breakpoint
CREATE TRIGGER `product_page_offers_other_product`
BEFORE INSERT ON `product_page_offers`
WHEN NOT EXISTS (
  SELECT 1 FROM `product_variants` AS offer_sku
  WHERE offer_sku.`id` = NEW.`variant_id` AND offer_sku.`deleted_at` IS NULL AND offer_sku.`product_id` <> NEW.`product_id`
)
BEGIN
  SELECT RAISE(ABORT, 'product_page_offers_variant_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `product_page_offers_limit`
BEFORE INSERT ON `product_page_offers`
WHEN (SELECT count(*) FROM `product_page_offers` AS existing WHERE existing.`product_id` = NEW.`product_id`) >= 20
BEGIN
  SELECT RAISE(ABORT, 'product_page_offers_limit');
END;
--> statement-breakpoint
CREATE TRIGGER `product_page_offers_identity_immutable`
BEFORE UPDATE OF `product_id`, `variant_id` ON `product_page_offers`
WHEN NEW.`product_id` IS NOT OLD.`product_id` OR NEW.`variant_id` IS NOT OLD.`variant_id`
BEGIN
  SELECT RAISE(ABORT, 'product_page_offers_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_variant_components_ins` AFTER INSERT ON `variant_components`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`kit_variant_id`), 't:variant_components')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_variant_components_del` AFTER DELETE ON `variant_components`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`kit_variant_id`), 't:variant_components')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_variant_components_upd` AFTER UPDATE ON `variant_components`
WHEN (OLD.`kit_variant_id` IS NOT NEW.`kit_variant_id` OR OLD.`component_variant_id` IS NOT NEW.`component_variant_id` OR OLD.`quantity` IS NOT NEW.`quantity` OR OLD.`position` IS NOT NEW.`position`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`kit_variant_id`), 't:variant_components')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_variant_components_upd_old` AFTER UPDATE ON `variant_components`
WHEN (OLD.`kit_variant_id` IS NOT NEW.`kit_variant_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`kit_variant_id`), 't:variant_components')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_page_offers_ins` AFTER INSERT ON `product_page_offers`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`product_id`, 't:product_page_offers')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_page_offers_del` AFTER DELETE ON `product_page_offers`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`product_id`, 't:product_page_offers')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_page_offers_upd` AFTER UPDATE ON `product_page_offers`
WHEN (OLD.`product_id` IS NOT NEW.`product_id` OR OLD.`variant_id` IS NOT NEW.`variant_id` OR OLD.`position` IS NOT NEW.`position`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`product_id`, 't:product_page_offers')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_page_offers_upd_old` AFTER UPDATE ON `product_page_offers`
WHEN (OLD.`product_id` IS NOT NEW.`product_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`product_id`, 't:product_page_offers')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (224, '0224_kits_and_page_offers', '16201aca1d7b85f95f38171bcda4ca6538de70c124863e9d42e177f6b5ecfca7');
