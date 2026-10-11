CREATE TABLE `recommendation_order_products` (
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`buyer` text,
	PRIMARY KEY(`order_id`, `product_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recommendation_order_products_created_idx` ON `recommendation_order_products` (`created_at`,`product_id`,`buyer`);
--> statement-breakpoint
CREATE INDEX `recommendation_order_products_product_idx` ON `recommendation_order_products` (`product_id`,`created_at`,`buyer`);
--> statement-breakpoint
CREATE INDEX `product_buyer_state_scope_idx` ON `product_buyer_state` (`is_public`,`product_id`,`from_minor`,`to_minor`);
--> statement-breakpoint
INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
SELECT DISTINCT o.id, item.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email)))
FROM orders o JOIN order_items item ON item.order_id = o.id WHERE o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_item_insert
AFTER INSERT ON order_items
BEGIN
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
    SELECT o.id, NEW.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email))) FROM orders o
    WHERE o.id = NEW.order_id AND o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS NOT excluded.created_at
     OR recommendation_order_products.buyer IS NOT excluded.buyer;
END;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_item_delete
AFTER DELETE ON order_items
BEGIN
  DELETE FROM recommendation_order_products
    WHERE order_id = OLD.order_id AND product_id = OLD.product_id
      AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = OLD.order_id AND item.product_id = OLD.product_id);
END;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_item_move_remove
AFTER UPDATE OF order_id, product_id ON order_items
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.product_id IS NOT NEW.product_id
BEGIN
  DELETE FROM recommendation_order_products
    WHERE order_id = OLD.order_id AND product_id = OLD.product_id
      AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = OLD.order_id AND item.product_id = OLD.product_id);
END;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_item_move_insert
AFTER UPDATE OF order_id, product_id ON order_items
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.product_id IS NOT NEW.product_id
BEGIN
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
    SELECT o.id, NEW.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email))) FROM orders o
    WHERE o.id = NEW.order_id AND o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS NOT excluded.created_at
     OR recommendation_order_products.buyer IS NOT excluded.buyer;
END;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_order_remove
AFTER UPDATE OF status, deleted_at ON orders
WHEN (OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at) AND NOT (NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND NEW.deleted_at IS NULL)
BEGIN
  DELETE FROM recommendation_order_products WHERE order_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER recommendation_order_products_order_refresh
AFTER UPDATE OF status, deleted_at, created_at, customer_phone, customer_email ON orders
WHEN (OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.created_at IS NOT NEW.created_at OR OLD.customer_phone IS NOT NEW.customer_phone OR OLD.customer_email IS NOT NEW.customer_email) AND NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
       SELECT DISTINCT NEW.id, item.product_id, NEW.created_at, coalesce(nullif(NEW.customer_phone, ''), lower(trim(NEW.customer_email)))
       FROM order_items item WHERE item.order_id = NEW.id ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS NOT excluded.created_at
     OR recommendation_order_products.buyer IS NOT excluded.buyer;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_orders_upd;
--> statement-breakpoint
CREATE TRIGGER `cdep_orders_upd` AFTER UPDATE ON `orders`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`customer_phone` IS NOT NEW.`customer_phone` OR OLD.`customer_email` IS NOT NEW.`customer_email` OR OLD.`created_at` IS NOT NEW.`created_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)
  AND EXISTS (SELECT 1 WHERE NEW.deleted_at IS NULL AND NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('recommendation-signals', 't:orders')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_orders_upd_old;
--> statement-breakpoint
CREATE TRIGGER `cdep_orders_upd_old` AFTER UPDATE ON `orders`
WHEN (OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`status` IS NOT NEW.`status`)
  AND EXISTS (SELECT 1 WHERE OLD.deleted_at IS NULL AND OLD.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed'))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('recommendation-signals', 't:orders')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_order_items_upd;
--> statement-breakpoint
CREATE TRIGGER `cdep_order_items_upd` AFTER UPDATE ON `order_items`
WHEN (OLD.`product_id` IS NOT NEW.`product_id` OR OLD.`order_id` IS NOT NEW.`order_id` OR OLD.`created_at` IS NOT NEW.`created_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('recommendation-signals', 't:order_items')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (139, '0139_recommendation_order_products', '77125e88788835063573d29d56110ace40717ffc7f5f6b36f63493c30eb10e1b');
