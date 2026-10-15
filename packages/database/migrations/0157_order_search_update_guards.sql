-- Order operations do not change searchable text. Avoid FTS delete/insert
-- cycles (and their segment merges) unless a term or its row identity changes.
DROP TRIGGER `orders_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER `orders_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_before_update`
BEFORE UPDATE ON `orders`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`id` IS NOT NEW.`id`
  OR OLD.`customer_name` IS NOT NEW.`customer_name`
  OR OLD.`customer_phone` IS NOT NEW.`customer_phone`
  OR OLD.`customer_email` IS NOT NEW.`customer_email`
BEGIN
  INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES ('delete', OLD.`rowid`, OLD.`customer_name`, OLD.`customer_phone`, OLD.`customer_email`, OLD.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_after_update`
AFTER UPDATE ON `orders`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`id` IS NOT NEW.`id`
  OR OLD.`customer_name` IS NOT NEW.`customer_name`
  OR OLD.`customer_phone` IS NOT NEW.`customer_phone`
  OR OLD.`customer_email` IS NOT NEW.`customer_email`
BEGIN
  INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES (NEW.`rowid`, NEW.`customer_name`, NEW.`customer_phone`, NEW.`customer_email`, NEW.`id`);
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (157, '0157_order_search_update_guards', '82dd0eaab9a95115f9f744284962f88b16e4b98c50b3b2f7b658fe7837f87424');
