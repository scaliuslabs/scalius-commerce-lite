-- Search reads a rich-text column's search text, computed where the text is
-- written (@scalius/shared/search-text, richTextSearchText: plain text of
-- the first 40,000 characters of HTML, folded, at most 20,000 characters),
-- never markup parsed in SQL. The companion columns (description_search_text,
-- content_search_text) are NULL on every existing row: until the scheduled
-- backfill fills a row, search indexes the first 20,000 characters of its raw
-- column on every provider, so nothing here re-reads the catalogue. Every
-- write path moves the row's search revision (*_search_rev) with the search
-- text; a change of the raw column that leaves it (SQL outside the write path)
-- clears the search text (the *_stale triggers) and the backfill fills it
-- again. The index triggers compare the text they index, so a save that keeps
-- the search text re-indexes nothing.
-- D1: every FTS5 table's four triggers name the columns they read (UPDATE OF:
-- a price, stock or status write neither fires nor compiles them), ignore the
-- zero-width joiner and non-joiner and read the precomposed Bengali nukta
-- letters decomposed; only rows holding such a character, a short column past
-- 2,000 characters or a rich-text one past 20,000, are indexed again. Never run
-- FTS5's 'rebuild' on them (nor 'integrity-check' with rank 1, which compares
-- the index with the raw columns: rank 0 and PRAGMA integrity_check hold).
-- Turso: the marker expands into the search index's refresh
-- (searchIndexSqliteRefreshStatements). External providers upgrade under the
-- verified write freeze.
ALTER TABLE `categories` ADD `description_search_text` text;;
--> statement-breakpoint
ALTER TABLE `categories` ADD `description_search_rev` integer DEFAULT 0 NOT NULL;;
--> statement-breakpoint
CREATE INDEX `categories_search_text_pending_idx` ON `categories` (`id`) WHERE "categories"."description_search_text" IS NULL AND "categories"."description" IS NOT NULL AND "categories"."description_search_rev" >= 0;;
--> statement-breakpoint
ALTER TABLE `products` ADD `description_search_text` text;;
--> statement-breakpoint
ALTER TABLE `products` ADD `description_search_rev` integer DEFAULT 0 NOT NULL;;
--> statement-breakpoint
CREATE INDEX `products_search_text_pending_idx` ON `products` (`id`) WHERE "products"."description_search_text" IS NULL AND "products"."description" IS NOT NULL AND "products"."description_search_rev" >= 0;;
--> statement-breakpoint
ALTER TABLE `pages` ADD `content_search_text` text;;
--> statement-breakpoint
ALTER TABLE `pages` ADD `content_search_rev` integer DEFAULT 0 NOT NULL;;
--> statement-breakpoint
CREATE INDEX `pages_search_text_pending_idx` ON `pages` (`id`) WHERE "pages"."content_search_text" IS NULL AND "pages"."content_search_rev" >= 0;;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_description_search_text_stale`;
--> statement-breakpoint
CREATE TRIGGER `products_description_search_text_stale`
AFTER UPDATE OF `description` ON `products`
WHEN OLD.`description` IS NOT NEW.`description` AND NEW.`description_search_rev` IS OLD.`description_search_rev` AND (NEW.`description_search_text` IS NOT NULL OR NEW.`description_search_rev` < 0)
BEGIN
  UPDATE `products` SET `description_search_text` = NULL, `description_search_rev` = 0 WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `categories_description_search_text_stale`;
--> statement-breakpoint
CREATE TRIGGER `categories_description_search_text_stale`
AFTER UPDATE OF `description` ON `categories`
WHEN OLD.`description` IS NOT NEW.`description` AND NEW.`description_search_rev` IS OLD.`description_search_rev` AND (NEW.`description_search_text` IS NOT NULL OR NEW.`description_search_rev` < 0)
BEGIN
  UPDATE `categories` SET `description_search_text` = NULL, `description_search_rev` = 0 WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_content_search_text_stale`;
--> statement-breakpoint
CREATE TRIGGER `pages_content_search_text_stale`
AFTER UPDATE OF `content` ON `pages`
WHEN OLD.`content` IS NOT NEW.`content` AND NEW.`content_search_rev` IS OLD.`content_search_rev` AND (NEW.`content_search_text` IS NOT NULL OR NEW.`content_search_rev` < 0)
BEGIN
  UPDATE `pages` SET `content_search_text` = NULL, `content_search_rev` = 0 WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `products_fts_after_insert`
AFTER INSERT ON `products`
BEGIN
  INSERT INTO `products_fts` (`rowid`, `name`, `description`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.description_search_text, replace(replace(replace(replace(replace(substr(NEW.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_before_delete`
BEFORE DELETE ON `products`
BEGIN
  INSERT INTO `products_fts` (`products_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.description_search_text, replace(replace(replace(replace(replace(substr(OLD.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_before_update`
BEFORE UPDATE OF `name`, `description`, `description_search_text` ON `products`
WHEN OLD.name IS NOT NEW.name
  OR coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS NOT coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000))
BEGIN
  INSERT INTO `products_fts` (`products_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.description_search_text, replace(replace(replace(replace(replace(substr(OLD.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_after_update`
AFTER UPDATE OF `name`, `description`, `description_search_text` ON `products`
WHEN OLD.name IS NOT NEW.name
  OR coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS NOT coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000))
BEGIN
  INSERT INTO `products_fts` (`rowid`, `name`, `description`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.description_search_text, replace(replace(replace(replace(replace(substr(NEW.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
INSERT INTO `products_fts` (`products_fts`, `rowid`, `name`, `description`) SELECT 'delete', `rowid`, src.`name`, src.`description` FROM `products` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`description`, char(8204)) > 0 OR instr(src.`description`, char(8205)) > 0 OR instr(src.`description`, char(2524)) > 0 OR instr(src.`description`, char(2525)) > 0 OR instr(src.`description`, char(2527)) > 0 OR length(src.`description`) > 20000;
--> statement-breakpoint
INSERT INTO `products_fts` (`rowid`, `name`, `description`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(src.description_search_text, replace(replace(replace(replace(replace(substr(src.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))) FROM `products` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`description`, char(8204)) > 0 OR instr(src.`description`, char(8205)) > 0 OR instr(src.`description`, char(2524)) > 0 OR instr(src.`description`, char(2525)) > 0 OR instr(src.`description`, char(2527)) > 0 OR length(src.`description`) > 20000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_after_insert`
AFTER INSERT ON `product_variants`
BEGIN
  INSERT INTO `product_variants_fts` (`rowid`, `sku`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_delete`
BEFORE DELETE ON `product_variants`
BEGIN
  INSERT INTO `product_variants_fts` (`product_variants_fts`, `rowid`, `sku`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_update`
BEFORE UPDATE OF `sku` ON `product_variants`
WHEN OLD.sku IS NOT NEW.sku
BEGIN
  INSERT INTO `product_variants_fts` (`product_variants_fts`, `rowid`, `sku`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_after_update`
AFTER UPDATE OF `sku` ON `product_variants`
WHEN OLD.sku IS NOT NEW.sku
BEGIN
  INSERT INTO `product_variants_fts` (`rowid`, `sku`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `product_variants_fts` (`product_variants_fts`, `rowid`, `sku`) SELECT 'delete', `rowid`, src.`sku` FROM `product_variants` AS src WHERE instr(src.`sku`, char(8204)) > 0 OR instr(src.`sku`, char(8205)) > 0 OR instr(src.`sku`, char(2524)) > 0 OR instr(src.`sku`, char(2525)) > 0 OR instr(src.`sku`, char(2527)) > 0 OR length(src.`sku`) > 2000;
--> statement-breakpoint
INSERT INTO `product_variants_fts` (`rowid`, `sku`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `product_variants` AS src WHERE instr(src.`sku`, char(8204)) > 0 OR instr(src.`sku`, char(8205)) > 0 OR instr(src.`sku`, char(2524)) > 0 OR instr(src.`sku`, char(2525)) > 0 OR instr(src.`sku`, char(2527)) > 0 OR length(src.`sku`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `categories_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `categories_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `categories_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `categories_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `categories_fts_after_insert`
AFTER INSERT ON `categories`
BEGIN
  INSERT INTO `categories_fts` (`rowid`, `name`, `description`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.description_search_text, replace(replace(replace(replace(replace(substr(NEW.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `categories_fts_before_delete`
BEFORE DELETE ON `categories`
BEGIN
  INSERT INTO `categories_fts` (`categories_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.description_search_text, replace(replace(replace(replace(replace(substr(OLD.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `categories_fts_before_update`
BEFORE UPDATE OF `name`, `description`, `description_search_text` ON `categories`
WHEN OLD.name IS NOT NEW.name
  OR coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS NOT coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000))
BEGIN
  INSERT INTO `categories_fts` (`categories_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.description_search_text, replace(replace(replace(replace(replace(substr(OLD.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `categories_fts_after_update`
AFTER UPDATE OF `name`, `description`, `description_search_text` ON `categories`
WHEN OLD.name IS NOT NEW.name
  OR coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS NOT coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000))
BEGIN
  INSERT INTO `categories_fts` (`rowid`, `name`, `description`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.description_search_text, replace(replace(replace(replace(replace(substr(NEW.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
INSERT INTO `categories_fts` (`categories_fts`, `rowid`, `name`, `description`) SELECT 'delete', `rowid`, src.`name`, src.`description` FROM `categories` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`description`, char(8204)) > 0 OR instr(src.`description`, char(8205)) > 0 OR instr(src.`description`, char(2524)) > 0 OR instr(src.`description`, char(2525)) > 0 OR instr(src.`description`, char(2527)) > 0 OR length(src.`description`) > 20000;
--> statement-breakpoint
INSERT INTO `categories_fts` (`rowid`, `name`, `description`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(src.description_search_text, replace(replace(replace(replace(replace(substr(src.description, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))) FROM `categories` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`description`, char(8204)) > 0 OR instr(src.`description`, char(8205)) > 0 OR instr(src.`description`, char(2524)) > 0 OR instr(src.`description`, char(2525)) > 0 OR instr(src.`description`, char(2527)) > 0 OR length(src.`description`) > 20000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_after_insert`
AFTER INSERT ON `pages`
BEGIN
  INSERT INTO `pages_fts` (`rowid`, `title`, `content_col`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.content_search_text, replace(replace(replace(replace(replace(substr(NEW.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_delete`
BEFORE DELETE ON `pages`
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content_col`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.content_search_text, replace(replace(replace(replace(replace(substr(OLD.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_update`
BEFORE UPDATE OF `title`, `content`, `content_search_text` ON `pages`
WHEN OLD.title IS NOT NEW.title
  OR coalesce(OLD.content_search_text, substr(OLD.content, 1, 20000)) IS NOT coalesce(NEW.content_search_text, substr(NEW.content, 1, 20000))
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content_col`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.content_search_text, replace(replace(replace(replace(replace(substr(OLD.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_after_update`
AFTER UPDATE OF `title`, `content`, `content_search_text` ON `pages`
WHEN OLD.title IS NOT NEW.title
  OR coalesce(OLD.content_search_text, substr(OLD.content, 1, 20000)) IS NOT coalesce(NEW.content_search_text, substr(NEW.content, 1, 20000))
BEGIN
  INSERT INTO `pages_fts` (`rowid`, `title`, `content_col`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.content_search_text, replace(replace(replace(replace(replace(substr(NEW.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content_col`) SELECT 'delete', `rowid`, src.`title`, src.`content` FROM `pages` AS src WHERE instr(src.`title`, char(8204)) > 0 OR instr(src.`title`, char(8205)) > 0 OR instr(src.`title`, char(2524)) > 0 OR instr(src.`title`, char(2525)) > 0 OR instr(src.`title`, char(2527)) > 0 OR length(src.`title`) > 2000 OR instr(src.`content`, char(8204)) > 0 OR instr(src.`content`, char(8205)) > 0 OR instr(src.`content`, char(2524)) > 0 OR instr(src.`content`, char(2525)) > 0 OR instr(src.`content`, char(2527)) > 0 OR length(src.`content`) > 20000;
--> statement-breakpoint
INSERT INTO `pages_fts` (`rowid`, `title`, `content_col`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(src.content_search_text, replace(replace(replace(replace(replace(substr(src.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))) FROM `pages` AS src WHERE instr(src.`title`, char(8204)) > 0 OR instr(src.`title`, char(8205)) > 0 OR instr(src.`title`, char(2524)) > 0 OR instr(src.`title`, char(2525)) > 0 OR instr(src.`title`, char(2527)) > 0 OR length(src.`title`) > 2000 OR instr(src.`content`, char(8204)) > 0 OR instr(src.`content`, char(8205)) > 0 OR instr(src.`content`, char(2524)) > 0 OR instr(src.`content`, char(2525)) > 0 OR instr(src.`content`, char(2527)) > 0 OR length(src.`content`) > 20000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_after_insert`
AFTER INSERT ON `orders`
BEGIN
  INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_before_delete`
BEFORE DELETE ON `orders`
BEGIN
  INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_before_update`
BEFORE UPDATE OF `customer_name`, `customer_phone`, `customer_email`, `id` ON `orders`
WHEN OLD.customer_name IS NOT NEW.customer_name
  OR OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.customer_email IS NOT NEW.customer_email
  OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_after_update`
AFTER UPDATE OF `customer_name`, `customer_phone`, `customer_email`, `id` ON `orders`
WHEN OLD.customer_name IS NOT NEW.customer_name
  OR OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.customer_email IS NOT NEW.customer_email
  OR OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`) SELECT 'delete', `rowid`, src.`customer_name`, src.`customer_phone`, src.`customer_email`, src.`id` FROM `orders` AS src WHERE instr(src.`customer_name`, char(8204)) > 0 OR instr(src.`customer_name`, char(8205)) > 0 OR instr(src.`customer_name`, char(2524)) > 0 OR instr(src.`customer_name`, char(2525)) > 0 OR instr(src.`customer_name`, char(2527)) > 0 OR length(src.`customer_name`) > 2000 OR instr(src.`customer_phone`, char(8204)) > 0 OR instr(src.`customer_phone`, char(8205)) > 0 OR instr(src.`customer_phone`, char(2524)) > 0 OR instr(src.`customer_phone`, char(2525)) > 0 OR instr(src.`customer_phone`, char(2527)) > 0 OR length(src.`customer_phone`) > 2000 OR instr(src.`customer_email`, char(8204)) > 0 OR instr(src.`customer_email`, char(8205)) > 0 OR instr(src.`customer_email`, char(2524)) > 0 OR instr(src.`customer_email`, char(2525)) > 0 OR instr(src.`customer_email`, char(2527)) > 0 OR length(src.`customer_email`) > 2000 OR instr(src.`id`, char(8204)) > 0 OR instr(src.`id`, char(8205)) > 0 OR instr(src.`id`, char(2524)) > 0 OR instr(src.`id`, char(2525)) > 0 OR instr(src.`id`, char(2527)) > 0 OR length(src.`id`) > 2000;
--> statement-breakpoint
INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `order_id`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `orders` AS src WHERE instr(src.`customer_name`, char(8204)) > 0 OR instr(src.`customer_name`, char(8205)) > 0 OR instr(src.`customer_name`, char(2524)) > 0 OR instr(src.`customer_name`, char(2525)) > 0 OR instr(src.`customer_name`, char(2527)) > 0 OR length(src.`customer_name`) > 2000 OR instr(src.`customer_phone`, char(8204)) > 0 OR instr(src.`customer_phone`, char(8205)) > 0 OR instr(src.`customer_phone`, char(2524)) > 0 OR instr(src.`customer_phone`, char(2525)) > 0 OR instr(src.`customer_phone`, char(2527)) > 0 OR length(src.`customer_phone`) > 2000 OR instr(src.`customer_email`, char(8204)) > 0 OR instr(src.`customer_email`, char(8205)) > 0 OR instr(src.`customer_email`, char(2524)) > 0 OR instr(src.`customer_email`, char(2525)) > 0 OR instr(src.`customer_email`, char(2527)) > 0 OR length(src.`customer_email`) > 2000 OR instr(src.`id`, char(8204)) > 0 OR instr(src.`id`, char(8205)) > 0 OR instr(src.`id`, char(2524)) > 0 OR instr(src.`id`, char(2525)) > 0 OR instr(src.`id`, char(2527)) > 0 OR length(src.`id`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_after_insert`
AFTER INSERT ON `customers`
BEGIN
  INSERT INTO `customers_fts` (`rowid`, `name`, `phone`, `email`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_before_delete`
BEFORE DELETE ON `customers`
BEGIN
  INSERT INTO `customers_fts` (`customers_fts`, `rowid`, `name`, `phone`, `email`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_before_update`
BEFORE UPDATE OF `name`, `phone`, `email` ON `customers`
WHEN OLD.name IS NOT NEW.name
  OR OLD.phone IS NOT NEW.phone
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO `customers_fts` (`customers_fts`, `rowid`, `name`, `phone`, `email`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_after_update`
AFTER UPDATE OF `name`, `phone`, `email` ON `customers`
WHEN OLD.name IS NOT NEW.name
  OR OLD.phone IS NOT NEW.phone
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO `customers_fts` (`rowid`, `name`, `phone`, `email`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `customers_fts` (`customers_fts`, `rowid`, `name`, `phone`, `email`) SELECT 'delete', `rowid`, src.`name`, src.`phone`, src.`email` FROM `customers` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`phone`, char(8204)) > 0 OR instr(src.`phone`, char(8205)) > 0 OR instr(src.`phone`, char(2524)) > 0 OR instr(src.`phone`, char(2525)) > 0 OR instr(src.`phone`, char(2527)) > 0 OR length(src.`phone`) > 2000 OR instr(src.`email`, char(8204)) > 0 OR instr(src.`email`, char(8205)) > 0 OR instr(src.`email`, char(2524)) > 0 OR instr(src.`email`, char(2525)) > 0 OR instr(src.`email`, char(2527)) > 0 OR length(src.`email`) > 2000;
--> statement-breakpoint
INSERT INTO `customers_fts` (`rowid`, `name`, `phone`, `email`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `customers` AS src WHERE instr(src.`name`, char(8204)) > 0 OR instr(src.`name`, char(8205)) > 0 OR instr(src.`name`, char(2524)) > 0 OR instr(src.`name`, char(2525)) > 0 OR instr(src.`name`, char(2527)) > 0 OR length(src.`name`) > 2000 OR instr(src.`phone`, char(8204)) > 0 OR instr(src.`phone`, char(8205)) > 0 OR instr(src.`phone`, char(2524)) > 0 OR instr(src.`phone`, char(2525)) > 0 OR instr(src.`phone`, char(2527)) > 0 OR length(src.`phone`) > 2000 OR instr(src.`email`, char(8204)) > 0 OR instr(src.`email`, char(8205)) > 0 OR instr(src.`email`, char(2524)) > 0 OR instr(src.`email`, char(2525)) > 0 OR instr(src.`email`, char(2527)) > 0 OR length(src.`email`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `abandoned_checkouts_fts_after_insert`
AFTER INSERT ON `abandoned_checkouts`
BEGIN
  INSERT INTO `abandoned_checkouts_fts` (`rowid`, `customer_phone`, `checkout_id`, `checkout_data`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `abandoned_checkouts_fts_before_delete`
BEFORE DELETE ON `abandoned_checkouts`
BEGIN
  INSERT INTO `abandoned_checkouts_fts` (`abandoned_checkouts_fts`, `rowid`, `customer_phone`, `checkout_id`, `checkout_data`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `abandoned_checkouts_fts_before_update`
BEFORE UPDATE OF `customer_phone`, `checkout_id`, `checkout_data` ON `abandoned_checkouts`
WHEN OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.checkout_data IS NOT NEW.checkout_data
BEGIN
  INSERT INTO `abandoned_checkouts_fts` (`abandoned_checkouts_fts`, `rowid`, `customer_phone`, `checkout_id`, `checkout_data`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `abandoned_checkouts_fts_after_update`
AFTER UPDATE OF `customer_phone`, `checkout_id`, `checkout_data` ON `abandoned_checkouts`
WHEN OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.checkout_data IS NOT NEW.checkout_data
BEGIN
  INSERT INTO `abandoned_checkouts_fts` (`rowid`, `customer_phone`, `checkout_id`, `checkout_data`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `abandoned_checkouts_fts` (`abandoned_checkouts_fts`, `rowid`, `customer_phone`, `checkout_id`, `checkout_data`) SELECT 'delete', `rowid`, src.`customer_phone`, src.`checkout_id`, src.`checkout_data` FROM `abandoned_checkouts` AS src WHERE instr(src.`customer_phone`, char(8204)) > 0 OR instr(src.`customer_phone`, char(8205)) > 0 OR instr(src.`customer_phone`, char(2524)) > 0 OR instr(src.`customer_phone`, char(2525)) > 0 OR instr(src.`customer_phone`, char(2527)) > 0 OR length(src.`customer_phone`) > 2000 OR instr(src.`checkout_id`, char(8204)) > 0 OR instr(src.`checkout_id`, char(8205)) > 0 OR instr(src.`checkout_id`, char(2524)) > 0 OR instr(src.`checkout_id`, char(2525)) > 0 OR instr(src.`checkout_id`, char(2527)) > 0 OR length(src.`checkout_id`) > 2000 OR instr(src.`checkout_data`, char(8204)) > 0 OR instr(src.`checkout_data`, char(8205)) > 0 OR instr(src.`checkout_data`, char(2524)) > 0 OR instr(src.`checkout_data`, char(2525)) > 0 OR instr(src.`checkout_data`, char(2527)) > 0 OR length(src.`checkout_data`) > 2000;
--> statement-breakpoint
INSERT INTO `abandoned_checkouts_fts` (`rowid`, `customer_phone`, `checkout_id`, `checkout_data`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `abandoned_checkouts` AS src WHERE instr(src.`customer_phone`, char(8204)) > 0 OR instr(src.`customer_phone`, char(8205)) > 0 OR instr(src.`customer_phone`, char(2524)) > 0 OR instr(src.`customer_phone`, char(2525)) > 0 OR instr(src.`customer_phone`, char(2527)) > 0 OR length(src.`customer_phone`) > 2000 OR instr(src.`checkout_id`, char(8204)) > 0 OR instr(src.`checkout_id`, char(8205)) > 0 OR instr(src.`checkout_id`, char(2524)) > 0 OR instr(src.`checkout_id`, char(2525)) > 0 OR instr(src.`checkout_id`, char(2527)) > 0 OR length(src.`checkout_id`) > 2000 OR instr(src.`checkout_data`, char(8204)) > 0 OR instr(src.`checkout_data`, char(8205)) > 0 OR instr(src.`checkout_data`, char(2524)) > 0 OR instr(src.`checkout_data`, char(2525)) > 0 OR instr(src.`checkout_data`, char(2527)) > 0 OR length(src.`checkout_data`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_after_insert`
AFTER INSERT ON `navigation_menu_items`
BEGIN
  INSERT INTO `navigation_menu_items_fts` (`rowid`, `label`, `target_value`, `target_id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_before_delete`
BEFORE DELETE ON `navigation_menu_items`
BEGIN
  INSERT INTO `navigation_menu_items_fts` (`navigation_menu_items_fts`, `rowid`, `label`, `target_value`, `target_id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_before_update`
BEFORE UPDATE OF `label`, `target_value`, `target_id` ON `navigation_menu_items`
WHEN OLD.label IS NOT NEW.label
  OR OLD.target_value IS NOT NEW.target_value
  OR OLD.target_id IS NOT NEW.target_id
BEGIN
  INSERT INTO `navigation_menu_items_fts` (`navigation_menu_items_fts`, `rowid`, `label`, `target_value`, `target_id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_after_update`
AFTER UPDATE OF `label`, `target_value`, `target_id` ON `navigation_menu_items`
WHEN OLD.label IS NOT NEW.label
  OR OLD.target_value IS NOT NEW.target_value
  OR OLD.target_id IS NOT NEW.target_id
BEGIN
  INSERT INTO `navigation_menu_items_fts` (`rowid`, `label`, `target_value`, `target_id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `navigation_menu_items_fts` (`navigation_menu_items_fts`, `rowid`, `label`, `target_value`, `target_id`) SELECT 'delete', `rowid`, src.`label`, src.`target_value`, src.`target_id` FROM `navigation_menu_items` AS src WHERE instr(src.`label`, char(8204)) > 0 OR instr(src.`label`, char(8205)) > 0 OR instr(src.`label`, char(2524)) > 0 OR instr(src.`label`, char(2525)) > 0 OR instr(src.`label`, char(2527)) > 0 OR length(src.`label`) > 2000 OR instr(src.`target_value`, char(8204)) > 0 OR instr(src.`target_value`, char(8205)) > 0 OR instr(src.`target_value`, char(2524)) > 0 OR instr(src.`target_value`, char(2525)) > 0 OR instr(src.`target_value`, char(2527)) > 0 OR length(src.`target_value`) > 2000 OR instr(src.`target_id`, char(8204)) > 0 OR instr(src.`target_id`, char(8205)) > 0 OR instr(src.`target_id`, char(2524)) > 0 OR instr(src.`target_id`, char(2525)) > 0 OR instr(src.`target_id`, char(2527)) > 0 OR length(src.`target_id`) > 2000;
--> statement-breakpoint
INSERT INTO `navigation_menu_items_fts` (`rowid`, `label`, `target_value`, `target_id`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `navigation_menu_items` AS src WHERE instr(src.`label`, char(8204)) > 0 OR instr(src.`label`, char(8205)) > 0 OR instr(src.`label`, char(2524)) > 0 OR instr(src.`label`, char(2525)) > 0 OR instr(src.`label`, char(2527)) > 0 OR length(src.`label`) > 2000 OR instr(src.`target_value`, char(8204)) > 0 OR instr(src.`target_value`, char(8205)) > 0 OR instr(src.`target_value`, char(2524)) > 0 OR instr(src.`target_value`, char(2525)) > 0 OR instr(src.`target_value`, char(2527)) > 0 OR length(src.`target_value`) > 2000 OR instr(src.`target_id`, char(8204)) > 0 OR instr(src.`target_id`, char(8205)) > 0 OR instr(src.`target_id`, char(2524)) > 0 OR instr(src.`target_id`, char(2525)) > 0 OR instr(src.`target_id`, char(2527)) > 0 OR length(src.`target_id`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_after_update`;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_fts_after_insert`
AFTER INSERT ON `product_reviews`
BEGIN
  INSERT INTO `product_reviews_fts` (`rowid`, `title`, `body`, `author_display_name`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_fts_before_delete`
BEFORE DELETE ON `product_reviews`
BEGIN
  INSERT INTO `product_reviews_fts` (`product_reviews_fts`, `rowid`, `title`, `body`, `author_display_name`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_fts_before_update`
BEFORE UPDATE OF `title`, `body`, `author_display_name` ON `product_reviews`
WHEN OLD.title IS NOT NEW.title
  OR OLD.body IS NOT NEW.body
  OR OLD.author_display_name IS NOT NEW.author_display_name
BEGIN
  INSERT INTO `product_reviews_fts` (`product_reviews_fts`, `rowid`, `title`, `body`, `author_display_name`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_fts_after_update`
AFTER UPDATE OF `title`, `body`, `author_display_name` ON `product_reviews`
WHEN OLD.title IS NOT NEW.title
  OR OLD.body IS NOT NEW.body
  OR OLD.author_display_name IS NOT NEW.author_display_name
BEGIN
  INSERT INTO `product_reviews_fts` (`rowid`, `title`, `body`, `author_display_name`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
INSERT INTO `product_reviews_fts` (`product_reviews_fts`, `rowid`, `title`, `body`, `author_display_name`) SELECT 'delete', `rowid`, src.`title`, src.`body`, src.`author_display_name` FROM `product_reviews` AS src WHERE instr(src.`title`, char(8204)) > 0 OR instr(src.`title`, char(8205)) > 0 OR instr(src.`title`, char(2524)) > 0 OR instr(src.`title`, char(2525)) > 0 OR instr(src.`title`, char(2527)) > 0 OR length(src.`title`) > 2000 OR instr(src.`body`, char(8204)) > 0 OR instr(src.`body`, char(8205)) > 0 OR instr(src.`body`, char(2524)) > 0 OR instr(src.`body`, char(2525)) > 0 OR instr(src.`body`, char(2527)) > 0 OR length(src.`body`) > 2000 OR instr(src.`author_display_name`, char(8204)) > 0 OR instr(src.`author_display_name`, char(8205)) > 0 OR instr(src.`author_display_name`, char(2524)) > 0 OR instr(src.`author_display_name`, char(2525)) > 0 OR instr(src.`author_display_name`, char(2527)) > 0 OR length(src.`author_display_name`) > 2000;
--> statement-breakpoint
INSERT INTO `product_reviews_fts` (`rowid`, `title`, `body`, `author_display_name`) SELECT `rowid`, replace(replace(replace(replace(replace(substr(src.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(src.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) FROM `product_reviews` AS src WHERE instr(src.`title`, char(8204)) > 0 OR instr(src.`title`, char(8205)) > 0 OR instr(src.`title`, char(2524)) > 0 OR instr(src.`title`, char(2525)) > 0 OR instr(src.`title`, char(2527)) > 0 OR length(src.`title`) > 2000 OR instr(src.`body`, char(8204)) > 0 OR instr(src.`body`, char(8205)) > 0 OR instr(src.`body`, char(2524)) > 0 OR instr(src.`body`, char(2525)) > 0 OR instr(src.`body`, char(2527)) > 0 OR length(src.`body`) > 2000 OR instr(src.`author_display_name`, char(8204)) > 0 OR instr(src.`author_display_name`, char(8205)) > 0 OR instr(src.`author_display_name`, char(2524)) > 0 OR instr(src.`author_display_name`, char(2525)) > 0 OR instr(src.`author_display_name`, char(2527)) > 0 OR length(src.`author_display_name`) > 2000;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_products_srch`;
--> statement-breakpoint
CREATE TRIGGER `cdep_products_srch` AFTER UPDATE ON `products`
WHEN (OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`category_id` IS NOT NEW.`category_id` OR OLD.`description_search_text` IS NOT NEW.`description_search_text`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('srch')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_categories_srch`;
--> statement-breakpoint
CREATE TRIGGER `cdep_categories_srch` AFTER UPDATE ON `categories`
WHEN (OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`description_search_text` IS NOT NEW.`description_search_text`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('srch')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_pages_srch`;
--> statement-breakpoint
CREATE TRIGGER `cdep_pages_srch` AFTER UPDATE ON `pages`
WHEN (OLD.`content_search_text` IS NOT NEW.`content_search_text`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pg:*')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
SELECT 'search_fts_terms:refresh';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (219, '0219_search_plain_text_and_unicode_fold', 'c7917ba7a7ee0a4e50d5131ebc59501c89df2ff403a3044c72d5b46c78d8956c');
