-- Markets step 4b (docs/MARKETS-DESIGN.md D9, "Step 4b implemented"): the
-- store's languages, translations and localized URL handles.
--
-- store_languages is the one list of the store's languages (Shopify's
-- Settings → Languages). It unifies the two lists the store had: the
-- languages of the market presences (published) and of the checkout copy
-- (unpublished unless a presence uses it). The default language is the backup
-- market's root presence locale; it takes the active checkout copy's
-- language, the copy buyers read today, so the root keeps its bytes. From
-- now on a presence names a store language (STORE_LANGUAGE_REQUIRED), the
-- default language stays published (STORE_LANGUAGE_DEFAULT_REQUIRED), a
-- language a presence uses cannot be removed (STORE_LANGUAGE_IN_USE) and a
-- language's code never changes (STORE_LANGUAGE_IMMUTABLE).
--
-- translations holds one row per resource, locale and market (NULL: every
-- market) with the translated fields (JSON) and the digest of the source
-- text each was made from: a source edit shows the field Outdated.
-- localized_slugs holds one URL handle per resource and locale, unique per
-- resource type and locale, and never another resource's source handle of
-- the same type (LOCALIZED_SLUG_TAKEN, checked from both sides). A
-- resource's translations and handles go with it when it is deleted; a
-- language's and a market's go with them (foreign keys).
--
-- The cache dependency triggers are generated from
-- packages/shared/src/cache-deps.ts: `tr:<type>:<id>` per resource (a
-- product's SKUs, options and values advance the product's),
-- `tr:slugs:<type>:<locale>` per handle space and `tr:locales` for the
-- presences' locales and the published languages.
CREATE TABLE `store_languages` (
	`locale` text PRIMARY KEY NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "store_languages_locale_shape" CHECK(length("store_languages"."locale") = 2 AND "store_languages"."locale" NOT GLOB '*[^a-z]*'),
	CONSTRAINT "store_languages_published_flag" CHECK("store_languages"."published" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `translations` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`locale` text NOT NULL,
	`market_id` text,
	`fields` text NOT NULL,
	`source_digest` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`locale`) REFERENCES `store_languages`(`locale`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "translations_id_shape" CHECK(substr("translations"."id", 1, 3) = 'tr_' AND length("translations"."id") BETWEEN 6 AND 40),
	CONSTRAINT "translations_resource_type_check" CHECK("translations"."resource_type" IN ('product', 'product_variant', 'product_option', 'product_option_value', 'collection', 'category', 'brand', 'page', 'menu', 'shipping_method', 'payment_method')),
	CONSTRAINT "translations_resource_id_length" CHECK(length("translations"."resource_id") BETWEEN 1 AND 64),
	CONSTRAINT "translations_locale_shape" CHECK(length("translations"."locale") = 2 AND "translations"."locale" NOT GLOB '*[^a-z]*'),
	CONSTRAINT "translations_fields_object" CHECK(json_valid("translations"."fields") AND json_type("translations"."fields") = 'object'),
	CONSTRAINT "translations_source_digest_object" CHECK(json_valid("translations"."source_digest") AND json_type("translations"."source_digest") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translations_identity_unique` ON `translations` (`resource_type`,`resource_id`,`locale`,coalesce("market_id", ''));
--> statement-breakpoint
CREATE INDEX `translations_locale_idx` ON `translations` (`locale`);
--> statement-breakpoint
CREATE INDEX `translations_market_idx` ON `translations` (`market_id`);
--> statement-breakpoint
CREATE TABLE `localized_slugs` (
	`resource_type` text NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`resource_id` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`resource_type`, `locale`, `slug`),
	FOREIGN KEY (`locale`) REFERENCES `store_languages`(`locale`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "localized_slugs_resource_type_check" CHECK("localized_slugs"."resource_type" IN ('product', 'category', 'brand', 'page')),
	CONSTRAINT "localized_slugs_resource_id_length" CHECK(length("localized_slugs"."resource_id") BETWEEN 1 AND 64),
	CONSTRAINT "localized_slugs_locale_shape" CHECK(length("localized_slugs"."locale") = 2 AND "localized_slugs"."locale" NOT GLOB '*[^a-z]*'),
	CONSTRAINT "localized_slugs_slug_shape" CHECK(length("localized_slugs"."slug") BETWEEN 1 AND 100 AND "localized_slugs"."slug" NOT GLOB '*[^a-z0-9-]*' AND substr("localized_slugs"."slug", 1, 1) <> '-' AND substr("localized_slugs"."slug", -1, 1) <> '-' AND instr("localized_slugs"."slug", '--') = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `localized_slugs_resource_unique` ON `localized_slugs` (`resource_type`,`resource_id`,`locale`);
--> statement-breakpoint
CREATE INDEX `localized_slugs_slug_idx` ON `localized_slugs` (`resource_type`,`slug`);
--> statement-breakpoint
CREATE INDEX `localized_slugs_locale_idx` ON `localized_slugs` (`locale`);
--> statement-breakpoint
-- The store's languages: every presence's language is published (a draft
-- market's presence is still not served), and the default language takes
-- the active checkout copy's language (the copy buyers read at the root).
INSERT INTO `store_languages` (`locale`, `published`)
SELECT DISTINCT `locale`, 1 FROM `market_presences` WHERE `locale` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `store_languages` (`locale`, `published`)
SELECT lower(substr(`code`, 1, 2)), 1 FROM `checkout_languages`
WHERE `is_active` = 1 AND `deleted_at` IS NULL AND length(`code`) >= 2 AND lower(substr(`code`, 1, 2)) NOT GLOB '*[^a-z]*'
ON CONFLICT (`locale`) DO UPDATE SET `published` = 1;
--> statement-breakpoint
UPDATE `market_presences` SET `locale` = (
  SELECT lower(substr(`code`, 1, 2)) FROM `checkout_languages`
  WHERE `is_active` = 1 AND `deleted_at` IS NULL AND length(`code`) >= 2 AND lower(substr(`code`, 1, 2)) NOT GLOB '*[^a-z]*'
  ORDER BY `is_default` DESC, `id` LIMIT 1
)
WHERE `kind` = 'subfolder' AND `value` = '' AND EXISTS (
  SELECT 1 FROM `checkout_languages` WHERE `is_active` = 1 AND `deleted_at` IS NULL AND length(`code`) >= 2 AND lower(substr(`code`, 1, 2)) NOT GLOB '*[^a-z]*'
);
--> statement-breakpoint
-- The other checkout copies' languages join the list unpublished.
INSERT INTO `store_languages` (`locale`, `published`)
SELECT DISTINCT lower(substr(`code`, 1, 2)), 0 FROM `checkout_languages`
WHERE `deleted_at` IS NULL AND length(`code`) >= 2 AND lower(substr(`code`, 1, 2)) NOT GLOB '*[^a-z]*'
ON CONFLICT (`locale`) DO NOTHING;
--> statement-breakpoint
-- A presence is in a store language, and the root presence's (the default
-- language) is published.
CREATE TRIGGER `market_presences_store_language_insert`
BEFORE INSERT ON `market_presences`
WHEN NOT EXISTS (SELECT 1 FROM `store_languages` WHERE `store_languages`.`locale` = NEW.`locale` AND (`store_languages`.`published` = 1 OR NEW.`value` <> '' OR NEW.`kind` <> 'subfolder'))
BEGIN
  SELECT RAISE(ABORT, 'STORE_LANGUAGE_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `market_presences_store_language_update`
BEFORE UPDATE OF `locale`, `value`, `kind` ON `market_presences`
WHEN NOT EXISTS (SELECT 1 FROM `store_languages` WHERE `store_languages`.`locale` = NEW.`locale` AND (`store_languages`.`published` = 1 OR NEW.`value` <> '' OR NEW.`kind` <> 'subfolder'))
BEGIN
  SELECT RAISE(ABORT, 'STORE_LANGUAGE_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `store_languages_in_use`
BEFORE DELETE ON `store_languages`
WHEN EXISTS (SELECT 1 FROM `market_presences` WHERE `market_presences`.`locale` = OLD.`locale`)
BEGIN
  SELECT RAISE(ABORT, 'STORE_LANGUAGE_IN_USE');
END;
--> statement-breakpoint
CREATE TRIGGER `store_languages_default_published`
BEFORE UPDATE OF `published` ON `store_languages`
WHEN NEW.`published` = 0 AND EXISTS (SELECT 1 FROM `market_presences` WHERE `market_presences`.`kind` = 'subfolder' AND `market_presences`.`value` = '' AND `market_presences`.`locale` = OLD.`locale`)
BEGIN
  SELECT RAISE(ABORT, 'STORE_LANGUAGE_DEFAULT_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `store_languages_locale_immutable`
BEFORE UPDATE OF `locale` ON `store_languages`
WHEN NEW.`locale` IS NOT OLD.`locale`
BEGIN
  SELECT RAISE(ABORT, 'STORE_LANGUAGE_IMMUTABLE');
END;
--> statement-breakpoint
-- A localized handle is never another resource's source handle of the same
-- type, checked from both sides.
CREATE TRIGGER `localized_slugs_source_taken_insert`
BEFORE INSERT ON `localized_slugs`
WHEN (NEW.`resource_type` = 'product' AND EXISTS (SELECT 1 FROM `products` WHERE `products`.`slug` = NEW.`slug` AND `products`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'category' AND EXISTS (SELECT 1 FROM `categories` WHERE `categories`.`slug` = NEW.`slug` AND `categories`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'brand' AND EXISTS (SELECT 1 FROM `brands` WHERE `brands`.`slug` = NEW.`slug` AND `brands`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'page' AND EXISTS (SELECT 1 FROM `pages` WHERE `pages`.`slug` = NEW.`slug` AND `pages`.`id` <> NEW.`resource_id`))
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `localized_slugs_source_taken_update`
BEFORE UPDATE OF `resource_type`, `resource_id`, `slug` ON `localized_slugs`
WHEN (NEW.`resource_type` = 'product' AND EXISTS (SELECT 1 FROM `products` WHERE `products`.`slug` = NEW.`slug` AND `products`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'category' AND EXISTS (SELECT 1 FROM `categories` WHERE `categories`.`slug` = NEW.`slug` AND `categories`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'brand' AND EXISTS (SELECT 1 FROM `brands` WHERE `brands`.`slug` = NEW.`slug` AND `brands`.`id` <> NEW.`resource_id`)) OR (NEW.`resource_type` = 'page' AND EXISTS (SELECT 1 FROM `pages` WHERE `pages`.`slug` = NEW.`slug` AND `pages`.`id` <> NEW.`resource_id`))
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `products_localized_slug_taken_insert`
BEFORE INSERT ON `products`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'product' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `products_localized_slug_taken_update`
BEFORE UPDATE OF `slug` ON `products`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'product' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `categories_localized_slug_taken_insert`
BEFORE INSERT ON `categories`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'category' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `categories_localized_slug_taken_update`
BEFORE UPDATE OF `slug` ON `categories`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'category' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `brands_localized_slug_taken_insert`
BEFORE INSERT ON `brands`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'brand' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `brands_localized_slug_taken_update`
BEFORE UPDATE OF `slug` ON `brands`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'brand' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `pages_localized_slug_taken_insert`
BEFORE INSERT ON `pages`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'page' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
CREATE TRIGGER `pages_localized_slug_taken_update`
BEFORE UPDATE OF `slug` ON `pages`
WHEN EXISTS (SELECT 1 FROM `localized_slugs` WHERE `localized_slugs`.`resource_type` = 'page' AND `localized_slugs`.`slug` = NEW.`slug` AND `localized_slugs`.`resource_id` <> NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'LOCALIZED_SLUG_TAKEN');
END;
--> statement-breakpoint
-- A deleted resource's translations and localized handles go with it.
CREATE TRIGGER `products_translations_cleanup`
AFTER DELETE ON `products`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'product' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `products_localized_slugs_cleanup`
AFTER DELETE ON `products`
BEGIN
  DELETE FROM `localized_slugs` WHERE `resource_type` = 'product' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_translations_cleanup`
AFTER DELETE ON `product_variants`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'product_variant' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_translations_cleanup`
AFTER DELETE ON `product_option_definitions`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'product_option' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_translations_cleanup`
AFTER DELETE ON `product_option_values`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'product_option_value' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `collections_translations_cleanup`
AFTER DELETE ON `collections`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'collection' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `categories_translations_cleanup`
AFTER DELETE ON `categories`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'category' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `categories_localized_slugs_cleanup`
AFTER DELETE ON `categories`
BEGIN
  DELETE FROM `localized_slugs` WHERE `resource_type` = 'category' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `brands_translations_cleanup`
AFTER DELETE ON `brands`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'brand' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `brands_localized_slugs_cleanup`
AFTER DELETE ON `brands`
BEGIN
  DELETE FROM `localized_slugs` WHERE `resource_type` = 'brand' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `pages_translations_cleanup`
AFTER DELETE ON `pages`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'page' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `pages_localized_slugs_cleanup`
AFTER DELETE ON `pages`
BEGIN
  DELETE FROM `localized_slugs` WHERE `resource_type` = 'page' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `navigation_menus_translations_cleanup`
AFTER DELETE ON `navigation_menus`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'menu' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_translations_cleanup`
AFTER DELETE ON `shipping_methods`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'shipping_method' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_locales_ins` AFTER INSERT ON `market_presences`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:locales', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_locales_del` AFTER DELETE ON `market_presences`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:locales', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_locales_upd` AFTER UPDATE ON `market_presences`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`kind` IS NOT NEW.`kind` OR OLD.`value` IS NOT NEW.`value` OR OLD.`locale` IS NOT NEW.`locale`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:locales', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_store_languages_ins` AFTER INSERT ON `store_languages`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:*', 'tr:locales', 't:store_languages')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_store_languages_del` AFTER DELETE ON `store_languages`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:*', 'tr:locales', 't:store_languages')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_store_languages_upd` AFTER UPDATE ON `store_languages`
WHEN (OLD.`locale` IS NOT NEW.`locale` OR OLD.`published` IS NOT NEW.`published`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:*', 'tr:locales', 't:store_languages')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_ins` AFTER INSERT ON `translations`
WHEN EXISTS (SELECT 1 WHERE NEW.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || NEW.`resource_type` || ':' || NEW.`resource_id`, 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_del` AFTER DELETE ON `translations`
WHEN EXISTS (SELECT 1 WHERE OLD.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || OLD.`resource_type` || ':' || OLD.`resource_id`, 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_upd` AFTER UPDATE ON `translations`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`locale` IS NOT NEW.`locale` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`source_digest` IS NOT NEW.`source_digest`)
  AND EXISTS (SELECT 1 WHERE NEW.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || NEW.`resource_type` || ':' || NEW.`resource_id`, 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_upd_old` AFTER UPDATE ON `translations`
WHEN (OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id`)
  AND EXISTS (SELECT 1 WHERE OLD.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || OLD.`resource_type` || ':' || OLD.`resource_id`, 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_sku_ins` AFTER INSERT ON `translations`
WHEN NEW.`resource_type` = 'product_variant'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_sku_del` AFTER DELETE ON `translations`
WHEN OLD.`resource_type` = 'product_variant'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_sku_upd` AFTER UPDATE ON `translations`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`locale` IS NOT NEW.`locale` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`source_digest` IS NOT NEW.`source_digest`)
  AND NEW.`resource_type` = 'product_variant'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_sku_upd_old` AFTER UPDATE ON `translations`
WHEN (OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`resource_type` IS NOT NEW.`resource_type`)
  AND OLD.`resource_type` = 'product_variant'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_option_ins` AFTER INSERT ON `translations`
WHEN NEW.`resource_type` = 'product_option'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_option_definitions` WHERE `id` = NEW.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_option_del` AFTER DELETE ON `translations`
WHEN OLD.`resource_type` = 'product_option'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_option_definitions` WHERE `id` = OLD.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_option_upd` AFTER UPDATE ON `translations`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`locale` IS NOT NEW.`locale` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`source_digest` IS NOT NEW.`source_digest`)
  AND NEW.`resource_type` = 'product_option'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_option_definitions` WHERE `id` = NEW.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_option_upd_old` AFTER UPDATE ON `translations`
WHEN (OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`resource_type` IS NOT NEW.`resource_type`)
  AND OLD.`resource_type` = 'product_option'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:product:' || (SELECT `product_id` FROM `product_option_definitions` WHERE `id` = OLD.`resource_id`), 't:translations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_value_ins` AFTER INSERT ON `translations`
WHEN NEW.`resource_type` = 'product_option_value'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:translations')) AS key_list UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = NEW.resource_id) AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_value_del` AFTER DELETE ON `translations`
WHEN OLD.`resource_type` = 'product_option_value'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:translations')) AS key_list UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = OLD.resource_id) AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_value_upd` AFTER UPDATE ON `translations`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`locale` IS NOT NEW.`locale` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`source_digest` IS NOT NEW.`source_digest`)
  AND NEW.`resource_type` = 'product_option_value'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:translations')) AS key_list UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = NEW.resource_id) AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_translations_value_upd_old` AFTER UPDATE ON `translations`
WHEN (OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`resource_type` IS NOT NEW.`resource_type`)
  AND OLD.`resource_type` = 'product_option_value'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:translations')) AS key_list UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = OLD.resource_id) AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_localized_slugs_ins` AFTER INSERT ON `localized_slugs`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || NEW.`resource_type` || ':' || NEW.`resource_id`, 'tr:slugs:' || NEW.`resource_type` || ':' || NEW.`locale`, 't:localized_slugs')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_localized_slugs_del` AFTER DELETE ON `localized_slugs`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || OLD.`resource_type` || ':' || OLD.`resource_id`, 'tr:slugs:' || OLD.`resource_type` || ':' || OLD.`locale`, 't:localized_slugs')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_localized_slugs_upd` AFTER UPDATE ON `localized_slugs`
WHEN (OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`locale` IS NOT NEW.`locale` OR OLD.`slug` IS NOT NEW.`slug` OR OLD.`resource_id` IS NOT NEW.`resource_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || NEW.`resource_type` || ':' || NEW.`resource_id`, 'tr:slugs:' || NEW.`resource_type` || ':' || NEW.`locale`, 't:localized_slugs')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_localized_slugs_upd_old` AFTER UPDATE ON `localized_slugs`
WHEN (OLD.`resource_type` IS NOT NEW.`resource_type` OR OLD.`resource_id` IS NOT NEW.`resource_id` OR OLD.`locale` IS NOT NEW.`locale`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tr:' || OLD.`resource_type` || ':' || OLD.`resource_id`, 'tr:slugs:' || OLD.`resource_type` || ':' || OLD.`locale`, 't:localized_slugs')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (121, '0121_translations', '195a3ba12533fb28cd2855756dcd0306b365d174996e68115e9f26f79967f3fe');
