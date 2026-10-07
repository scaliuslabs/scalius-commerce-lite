-- Markets step 5 (docs/MARKETS-DESIGN.md D6, "Step 5 implemented"): sales
-- channels, product publications and channel stock locations.
--
-- sales_channels lists where products are published. Like Shopify, each
-- surface is its own channel: the online store (`sc_online_store`, always
-- active), the Google catalogue feed (`sc_google`), the Meta catalogue feed
-- (`sc_meta`) and AI agents (`sc_agents`: the UCP catalogue and buyer-agent
-- checkout). An app declares more (`kind = 'app'`, its `plugin_id`).
--
-- product_channel_publications: a product is published to a channel while its
-- row has no unpublished_at. Every product is backfilled to every channel, so
-- the storefront, the feeds and UCP list what they listed before. The product
-- flag exclude_from_product_feed becomes the feed and agent publications (one
-- truth): a product it excluded is unpublished from Google, Meta and AI agents,
-- and the column is dropped. A new product is published to every channel.
--
-- sales_channel_locations: the locations whose on-hand a channel sells. Every
-- channel is linked to every location, and a new channel or location is
-- linked to all of the other kind, so a channel's sellable stock stays the
-- SKU's stock until a merchant unlinks one. Never a per-channel stock count.
--
-- orders.sales_channel_id names the channel an order sold from, beside the
-- attribution `channel`: buyer agents' orders sell from AI agents, every other
-- order from the online store. It never changes.
--
-- The default inventory location takes the store's country (the backup
-- market's) while nobody has edited it: its country was a 'BD' literal.
--
-- Unpublishing a product or deactivating a channel advances the checkout
-- authority fence. The cache dependency and event triggers are generated
-- from packages/shared/src/cache-deps.ts and
-- packages/database/scripts/event-outbox-triggers.ts.
CREATE TABLE `sales_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`plugin_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "sales_channels_id_shape" CHECK(length("sales_channels"."id") BETWEEN 4 AND 160 AND "sales_channels"."id" NOT GLOB '*[^a-z0-9._:-]*'),
	CONSTRAINT "sales_channels_handle_shape" CHECK(length("sales_channels"."handle") BETWEEN 1 AND 160 AND "sales_channels"."handle" NOT GLOB '*[^a-z0-9._:-]*'),
	CONSTRAINT "sales_channels_name_length" CHECK("sales_channels"."name" = trim("sales_channels"."name") AND length("sales_channels"."name") BETWEEN 1 AND 80),
	CONSTRAINT "sales_channels_kind_check" CHECK("sales_channels"."kind" IN ('online_store', 'pos', 'catalog_feed', 'agent', 'app')),
	CONSTRAINT "sales_channels_status_check" CHECK("sales_channels"."status" IN ('active', 'inactive')),
	CONSTRAINT "sales_channels_app_plugin" CHECK(("sales_channels"."kind" = 'app') = ("sales_channels"."plugin_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_channels_handle_unique` ON `sales_channels` (lower(trim("handle")));
--> statement-breakpoint
CREATE INDEX `sales_channels_plugin_idx` ON `sales_channels` (`plugin_id`) WHERE "sales_channels"."plugin_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `product_channel_publications` (
	`product_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`published_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`unpublished_at` integer,
	PRIMARY KEY(`product_id`, `channel_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `sales_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_channel_publications_dates" CHECK("product_channel_publications"."unpublished_at" IS NULL OR "product_channel_publications"."unpublished_at" >= "product_channel_publications"."published_at")
);
--> statement-breakpoint
CREATE INDEX `product_channel_publications_channel_idx` ON `product_channel_publications` (`channel_id`,`product_id`) WHERE "product_channel_publications"."unpublished_at" IS NULL;
--> statement-breakpoint
CREATE TABLE `sales_channel_locations` (
	`channel_id` text NOT NULL,
	`location_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`channel_id`, `location_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `sales_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sales_channel_locations_location_idx` ON `sales_channel_locations` (`location_id`);
--> statement-breakpoint
-- The built-in channels (the dashboard shows their names in the staff
-- member's language).
INSERT INTO `sales_channels` (`id`, `handle`, `name`, `kind`, `status`, `position`) VALUES
	('sc_online_store', 'online-store', 'Online store', 'online_store', 'active', 0),
	('sc_google', 'google', 'Google', 'catalog_feed', 'active', 1),
	('sc_meta', 'meta', 'Facebook and Instagram', 'catalog_feed', 'active', 2),
	('sc_agents', 'agents', 'AI agents', 'agent', 'active', 3);
--> statement-breakpoint
-- Every channel sells every location's stock, as checkout did before.
INSERT INTO `sales_channel_locations` (`channel_id`, `location_id`)
SELECT `sales_channels`.`id`, `inventory_locations`.`id` FROM `sales_channels`, `inventory_locations`;
--> statement-breakpoint
-- Every product is published to every channel, except that a product the
-- feed flag excluded is unpublished from the feeds and AI agents (UCP read
-- the same flag).
INSERT INTO `product_channel_publications` (`product_id`, `channel_id`, `published_at`, `unpublished_at`)
SELECT `products`.`id`, `sales_channels`.`id`, min(`products`.`created_at`, unixepoch()),
	CASE WHEN `products`.`exclude_from_product_feed` = 1 AND `sales_channels`.`id` <> 'sc_online_store' THEN unixepoch() ELSE NULL END
FROM `products`, `sales_channels`;
--> statement-breakpoint
-- The feed flag's triggers are reinstalled without it below.
DROP TRIGGER IF EXISTS `cdep_products_upd`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_products_seo`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `exclude_from_product_feed`;
--> statement-breakpoint
-- A row written without a sales channel (raw SQL) is the online store's.
-- Order writers set it in the insert.
ALTER TABLE `orders` ADD `sales_channel_id` text DEFAULT 'sc_online_store' NOT NULL;
--> statement-breakpoint
CREATE INDEX `orders_sales_channel_idx` ON `orders` (`sales_channel_id`) WHERE "orders"."sales_channel_id" <> 'sc_online_store';
--> statement-breakpoint
UPDATE `orders` SET `sales_channel_id` = 'sc_agents' WHERE `channel` = 'agent';
--> statement-breakpoint
-- The default location takes the store's country while it is as 0102 made it.
UPDATE `inventory_locations`
SET `country_code` = (SELECT `country_code` FROM `market_countries` WHERE `market_id` = 'mkt_backup' ORDER BY `country_code` LIMIT 1), `updated_at` = unixepoch()
WHERE `id` = 'loc_default' AND `version` = 1
	AND `address_line1` IS NULL AND `city` IS NULL AND `postal_code` IS NULL
	AND EXISTS (SELECT 1 FROM `market_countries` WHERE `market_id` = 'mkt_backup')
	AND NOT EXISTS (SELECT 1 FROM `market_countries` WHERE `market_id` = 'mkt_backup' AND `country_code` = `inventory_locations`.`country_code`);
--> statement-breakpoint
-- The online store is the storefront: it is always active and never removed.
CREATE TRIGGER `sales_channels_online_store_delete`
BEFORE DELETE ON `sales_channels`
WHEN OLD.`id` = 'sc_online_store'
BEGIN
  SELECT RAISE(ABORT, 'SALES_CHANNEL_ONLINE_STORE_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `sales_channels_online_store_status`
BEFORE UPDATE OF `status` ON `sales_channels`
WHEN NEW.`id` = 'sc_online_store' AND NEW.`status` <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'SALES_CHANNEL_ONLINE_STORE_REQUIRED');
END;
--> statement-breakpoint
-- A channel's kind and app never change (an app's channel is its own).
CREATE TRIGGER `sales_channels_identity_immutable`
BEFORE UPDATE OF `kind`, `plugin_id` ON `sales_channels`
WHEN NEW.`kind` IS NOT OLD.`kind` OR NEW.`plugin_id` IS NOT OLD.`plugin_id`
BEGIN
  SELECT RAISE(ABORT, 'SALES_CHANNEL_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
-- A new channel sells every location's stock; a new location is sold by
-- every channel.
CREATE TRIGGER `sales_channels_link_locations`
AFTER INSERT ON `sales_channels`
BEGIN
  INSERT INTO `sales_channel_locations` (`channel_id`, `location_id`) SELECT NEW.`id`, `inventory_locations`.`id` FROM `inventory_locations` WHERE `inventory_locations`.`id` IS NOT NULL ON CONFLICT DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_locations_link_channels`
AFTER INSERT ON `inventory_locations`
BEGIN
  INSERT INTO `sales_channel_locations` (`channel_id`, `location_id`) SELECT `sales_channels`.`id`, NEW.`id` FROM `sales_channels` WHERE `sales_channels`.`id` IS NOT NULL ON CONFLICT DO NOTHING;
END;
--> statement-breakpoint
-- A new product is published to every channel; the product form, the bulk
-- actions and the API unpublish it where the merchant says.
CREATE TRIGGER `products_publish_to_channels`
AFTER INSERT ON `products`
BEGIN
  INSERT INTO `product_channel_publications` (`product_id`, `channel_id`) SELECT NEW.`id`, `sales_channels`.`id` FROM `sales_channels` WHERE `sales_channels`.`id` IS NOT NULL ON CONFLICT DO NOTHING;
END;
--> statement-breakpoint
-- An order's sales channel never changes, and a channel with orders is
-- never deleted (the column's default could not carry a foreign key).
CREATE TRIGGER `orders_sales_channel_immutable`
BEFORE UPDATE OF `sales_channel_id` ON `orders`
WHEN NEW.`sales_channel_id` IS NOT OLD.`sales_channel_id`
BEGIN
  SELECT RAISE(ABORT, 'order sales channel is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `sales_channels_has_orders`
BEFORE DELETE ON `sales_channels`
WHEN EXISTS (SELECT 1 FROM `orders` WHERE `orders`.`sales_channel_id` = OLD.`id` AND `orders`.`sales_channel_id` <> 'sc_online_store')
BEGIN
  SELECT RAISE(ABORT, 'SALES_CHANNEL_HAS_ORDERS');
END;
--> statement-breakpoint
-- A checkout validated before a product left a channel, or a channel was
-- switched off, reviews again instead of committing.
CREATE TRIGGER `product_channel_publications_checkout_authority_update`
AFTER UPDATE OF `unpublished_at`, `channel_id`, `product_id` ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL AND (NEW.`unpublished_at` IS NOT NULL OR NEW.`channel_id` IS NOT OLD.`channel_id` OR NEW.`product_id` IS NOT OLD.`product_id`)
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_checkout_authority_delete`
AFTER DELETE ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `sales_channels_checkout_authority_update`
AFTER UPDATE OF `status` ON `sales_channels`
WHEN NEW.`status` IS NOT OLD.`status`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_published` AFTER INSERT ON `product_channel_publications`
WHEN NEW.`unpublished_at` IS NULL
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'published'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_republished` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`unpublished_at` IS NOT NULL AND NEW.`unpublished_at` IS NULL)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'published'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_unpublished` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`unpublished_at` IS NULL AND NEW.`unpublished_at` IS NOT NULL)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'unpublished'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_removed` AFTER DELETE ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', OLD.`product_id`, json_object('productId', OLD.`product_id`, 'channelId', OLD.`channel_id`, 'state', 'unpublished'));
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_products_upd` AFTER UPDATE ON `products`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`price_minor` IS NOT NEW.`price_minor` OR OLD.`category_id` IS NOT NEW.`category_id` OR OLD.`slug` IS NOT NEW.`slug` OR OLD.`meta_title` IS NOT NEW.`meta_title` OR OLD.`meta_description` IS NOT NEW.`meta_description` OR OLD.`canonical_path` IS NOT NEW.`canonical_path` OR OLD.`no_index` IS NOT NEW.`no_index` OR OLD.`exclude_from_sitemap` IS NOT NEW.`exclude_from_sitemap` OR OLD.`product_condition` IS NOT NEW.`product_condition` OR OLD.`created_at` IS NOT NEW.`created_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`discount_bps` IS NOT NEW.`discount_bps` OR OLD.`discount_type` IS NOT NEW.`discount_type` OR OLD.`discount_amount_minor` IS NOT NEW.`discount_amount_minor` OR OLD.`free_delivery` IS NOT NEW.`free_delivery` OR OLD.`tax_class_id` IS NOT NEW.`tax_class_id` OR OLD.`is_gift_card` IS NOT NEW.`is_gift_card` OR OLD.`customization_schema` IS NOT NEW.`customization_schema` OR OLD.`brand_id` IS NOT NEW.`brand_id` OR OLD.`page_template` IS NOT NEW.`page_template` OR OLD.`emi_eligible` IS NOT NEW.`emi_eligible` OR OLD.`warranty_policy_id` IS NOT NEW.`warranty_policy_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`id`, 't:products')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_products_seo` AFTER UPDATE ON `products`
WHEN (OLD.`no_index` IS NOT NEW.`no_index` OR OLD.`exclude_from_sitemap` IS NOT NEW.`exclude_from_sitemap`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:seo', 't:products')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_variants_chstock` AFTER UPDATE ON `product_variants`
WHEN (OLD.`stock` IS NOT NEW.`stock` OR OLD.`reserved_stock` IS NOT NEW.`reserved_stock`)
  AND EXISTS (SELECT 1 FROM sales_channels AS partial_channel, inventory_locations AS partial_location WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS partial_link WHERE partial_link.channel_id = partial_channel.id AND partial_link.location_id = partial_location.id))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`product_id`, 't:product_variants')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_variants_chstock_old` AFTER UPDATE ON `product_variants`
WHEN (OLD.`stock` IS NOT NEW.`stock` OR OLD.`reserved_stock` IS NOT NEW.`reserved_stock`)
  AND (OLD.`product_id` IS NOT NEW.`product_id`)
  AND EXISTS (SELECT 1 FROM sales_channels AS partial_channel, inventory_locations AS partial_location WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS partial_link WHERE partial_link.channel_id = partial_channel.id AND partial_link.location_id = partial_location.id))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`product_id`, 't:product_variants')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channels_ins` AFTER INSERT ON `sales_channels`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:seo', 't:sales_channels')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channels_del` AFTER DELETE ON `sales_channels`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:seo', 't:sales_channels')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channels_upd` AFTER UPDATE ON `sales_channels`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`kind` IS NOT NEW.`kind` OR OLD.`plugin_id` IS NOT NEW.`plugin_id` OR OLD.`status` IS NOT NEW.`status`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:seo', 't:sales_channels')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_ins` AFTER INSERT ON `product_channel_publications`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`product_id`, 'lm:seo', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_del` AFTER DELETE ON `product_channel_publications`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`product_id`, 'lm:seo', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_upd` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`product_id` IS NOT NEW.`product_id` OR OLD.`channel_id` IS NOT NEW.`channel_id` OR OLD.`unpublished_at` IS NOT NEW.`unpublished_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || NEW.`product_id`, 'lm:seo', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_upd_old` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`product_id` IS NOT NEW.`product_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('p:' || OLD.`product_id`, 'lm:seo', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_store_ins` AFTER INSERT ON `product_channel_publications`
WHEN NEW.`channel_id` = 'sc_online_store'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:all', 'srch', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_store_del` AFTER DELETE ON `product_channel_publications`
WHEN OLD.`channel_id` = 'sc_online_store'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:all', 'srch', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_store_upd` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`product_id` IS NOT NEW.`product_id` OR OLD.`channel_id` IS NOT NEW.`channel_id` OR OLD.`unpublished_at` IS NOT NEW.`unpublished_at`)
  AND NEW.`channel_id` = 'sc_online_store'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:all', 'srch', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_product_channel_publications_store_upd_old` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`channel_id` IS NOT NEW.`channel_id`)
  AND OLD.`channel_id` = 'sc_online_store'
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('lm:all', 'srch', 't:product_channel_publications')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channel_locations_ins` AFTER INSERT ON `sales_channel_locations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('store', 't:sales_channel_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channel_locations_del` AFTER DELETE ON `sales_channel_locations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('store', 't:sales_channel_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_sales_channel_locations_upd` AFTER UPDATE ON `sales_channel_locations`
WHEN (OLD.`channel_id` IS NOT NEW.`channel_id` OR OLD.`location_id` IS NOT NEW.`location_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('store', 't:sales_channel_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (122, '0122_sales_channels', '3b5f2dcf1a57cb669bb5fbe3a828ff25203e8dd8ddcd6e659226531a057ffa6f');
