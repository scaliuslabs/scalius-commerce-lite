-- What a buyer's account reads, at any order count (rules/orders/account-summary-reads-maintained-totals.md):
-- - `account_order_totals`: per account and currency, the live orders the
--   account owns that are not unfinished checkouts, and what the store holds
--   of them (paid, net of refunds, less disputes lost). Four triggers on
--   orders recompute the (account, currency) rows a write moves an order in
--   or out of; existing orders are counted here.
-- - `conversations.buyer_account_id`: the account that reads a thread on the
--   storefront (a store thread's customer, an order thread's order owner
--   while the order is live), kept by three triggers and filled here, with
--   its index. `conversations.topic`: the merchant topic a buyer chose.
-- - `customers.whatsapp`: the buyer's WhatsApp number when not the phone.
-- - `translations` is rebuilt to take the `conversation_topic` resource
--   (SQLite cannot widen a CHECK); its indexes and cache dependency
--   triggers are recreated exactly as generated. Every row is kept.
CREATE TABLE `account_order_totals` (
	`customer_id` text NOT NULL,
	`currency_code` text NOT NULL,
	`orders_count` integer DEFAULT 0 NOT NULL,
	`spent_minor` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`customer_id`, `currency_code`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_order_totals_nonnegative" CHECK("account_order_totals"."orders_count" >= 0 AND "account_order_totals"."spent_minor" >= 0)
);
--> statement-breakpoint
DROP TRIGGER `products_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `product_variants_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `product_option_definitions_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `product_option_values_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `collections_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `categories_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `brands_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `pages_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `navigation_menus_translations_cleanup`;
--> statement-breakpoint
DROP TRIGGER `shipping_methods_translations_cleanup`;
--> statement-breakpoint
CREATE TABLE `__new_translations` (
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
	CONSTRAINT "translations_id_shape" CHECK(substr("__new_translations"."id", 1, 3) = 'tr_' AND length("__new_translations"."id") BETWEEN 6 AND 40),
	CONSTRAINT "translations_resource_type_check" CHECK("__new_translations"."resource_type" IN ('product', 'product_variant', 'product_option', 'product_option_value', 'collection', 'category', 'brand', 'page', 'menu', 'shipping_method', 'payment_method', 'conversation_topic')),
	CONSTRAINT "translations_resource_id_length" CHECK(length("__new_translations"."resource_id") BETWEEN 1 AND 64),
	CONSTRAINT "translations_locale_shape" CHECK(length("__new_translations"."locale") = 2 AND "__new_translations"."locale" NOT GLOB '*[^a-z]*'),
	CONSTRAINT "translations_fields_object" CHECK(json_valid("__new_translations"."fields") AND json_type("__new_translations"."fields") = 'object'),
	CONSTRAINT "translations_source_digest_object" CHECK(json_valid("__new_translations"."source_digest") AND json_type("__new_translations"."source_digest") = 'object')
);
--> statement-breakpoint
INSERT INTO `__new_translations`("id", "resource_type", "resource_id", "locale", "market_id", "fields", "source_digest", "updated_at") SELECT "id", "resource_type", "resource_id", "locale", "market_id", "fields", "source_digest", "updated_at" FROM `translations`;
--> statement-breakpoint
DROP TABLE `translations`;
--> statement-breakpoint
ALTER TABLE `__new_translations` RENAME TO `translations`;
--> statement-breakpoint
CREATE UNIQUE INDEX `translations_identity_unique` ON `translations` (`resource_type`,`resource_id`,`locale`,coalesce("market_id", ''));
--> statement-breakpoint
CREATE INDEX `translations_locale_idx` ON `translations` (`locale`);
--> statement-breakpoint
CREATE INDEX `translations_market_idx` ON `translations` (`market_id`);
--> statement-breakpoint
CREATE TRIGGER `products_translations_cleanup`
AFTER DELETE ON `products`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'product' AND `resource_id` = OLD.`id`;
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
CREATE TRIGGER `brands_translations_cleanup`
AFTER DELETE ON `brands`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'brand' AND `resource_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `pages_translations_cleanup`
AFTER DELETE ON `pages`
BEGIN
  DELETE FROM `translations` WHERE `resource_type` = 'page' AND `resource_id` = OLD.`id`;
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
ALTER TABLE `customers` ADD `whatsapp` text;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `buyer_account_id` text;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `topic` text;
--> statement-breakpoint
CREATE INDEX `conversations_buyer_account_idx` ON `conversations` (`buyer_account_id`,"last_message_at" DESC,`id`) WHERE "conversations"."buyer_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_ins
AFTER INSERT ON orders
WHEN NEW.account_owner_customer_id IS NOT NULL
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT NEW.account_owner_customer_id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = NEW.account_owner_customer_id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_upd
AFTER UPDATE OF account_owner_customer_id, currency_code, paid_amount_minor, disputed_minor, deleted_at, status ON orders
WHEN NEW.account_owner_customer_id IS NOT NULL AND (OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR OLD.currency_code IS NOT NEW.currency_code OR OLD.paid_amount_minor IS NOT NEW.paid_amount_minor OR OLD.disputed_minor IS NOT NEW.disputed_minor OR OLD.deleted_at IS NOT NEW.deleted_at OR (OLD.status IS NOT NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete')))
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT NEW.account_owner_customer_id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = NEW.account_owner_customer_id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_upd_old
AFTER UPDATE OF account_owner_customer_id, currency_code ON orders
WHEN OLD.account_owner_customer_id IS NOT NULL AND (OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR OLD.currency_code IS NOT NEW.currency_code)
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT OLD.account_owner_customer_id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = OLD.account_owner_customer_id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_del
AFTER DELETE ON orders
WHEN OLD.account_owner_customer_id IS NOT NULL
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT OLD.account_owner_customer_id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = OLD.account_owner_customer_id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER conversations_buyer_account_store
AFTER INSERT ON conversations
WHEN NEW.subject_type = 'store' AND NEW.channel IS NULL AND NEW.customer_id IS NOT NULL
BEGIN
  UPDATE conversations SET buyer_account_id = NEW.customer_id WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER conversations_buyer_account_order
AFTER INSERT ON conversations
WHEN NEW.subject_type <> 'store' AND NEW.order_id IS NOT NULL
BEGIN
  UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order WHERE owner_order.id = NEW.order_id AND owner_order.deleted_at IS NULL) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER orders_conversations_buyer_account
AFTER UPDATE OF account_owner_customer_id, deleted_at ON orders
WHEN OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
BEGIN
  UPDATE conversations SET buyer_account_id = (CASE WHEN NEW.deleted_at IS NULL THEN NEW.account_owner_customer_id END) WHERE order_id = NEW.id AND subject_type <> 'store';
END;
--> statement-breakpoint
INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT orders.account_owner_customer_id, orders.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id IS NOT NULL AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    GROUP BY orders.account_owner_customer_id, orders.currency_code;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = customer_id WHERE subject_type = 'store' AND channel IS NULL AND customer_id IS NOT NULL;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order
    WHERE owner_order.id = conversations.order_id AND owner_order.deleted_at IS NULL)
    WHERE subject_type <> 'store' AND order_id IS NOT NULL;
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
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (225, '0225_account_data', '2791e86abc59b3355bc372fd0920e6fc0031d0ff840c11ba691e39497390a11c');
