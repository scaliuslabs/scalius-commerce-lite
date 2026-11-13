-- Search reads a rich-text column's search text, computed where the text is
-- written (@scalius/shared/search-text, richTextSearchText: plain text of
-- the first 40,000 characters of HTML, folded, at most 20,000 characters),
-- never markup parsed in SQL. The companion columns (description_search_text,
-- content_search_text) are NULL on every existing row: until the scheduled
-- backfill fills a row, search indexes the first 20,000 characters of its raw
-- column on every provider. Every
-- write path moves the row's search revision (*_search_rev) with the search
-- text; a change of the raw column that leaves it (SQL outside the write path)
-- clears the search text (the *_stale triggers) and the backfill fills it
-- again. The index triggers compare the text they index, so a save that keeps
-- the search text re-indexes nothing.
-- D1: every FTS5 table's four triggers name the columns they read (UPDATE OF:
-- a price, stock or status write neither fires nor compiles them), ignore the
-- zero-width joiner and non-joiner and read the precomposed Bengali nukta
-- letters decomposed. Every table but products_fts and categories_fts
-- (pages, orders, customers, abandoned checkouts, menu items, SKUs, reviews;
-- pages_fts and orders_fts had named a column their source lacks since 0000)
-- is made again, empty, over a view of exactly what its triggers index, so
-- FTS5's 'rebuild' and rank-1 'integrity-check' hold on it: this migration
-- reads and writes none of their rows, whatever the store's size. The
-- scheduled re-index fills them (about two rows written per row, 150 rows a
-- quarter hour on Free), pages first; until then their search finds the rows
-- indexed so far, and every row written meanwhile at once.
-- products_fts and categories_fts keep their rows; only a row holding such a
-- character, a name past 2,000 characters or a description past 20,000 is
-- indexed again here, about four rows written each (none on a store without
-- them; a catalogue of 25,000 such rows would use a Free day's writes). Never
-- run FTS5's 'rebuild' or the rank-1 'integrity-check' on these two: their
-- content is the raw table (rank 0 and PRAGMA integrity_check hold).
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
DROP TABLE IF EXISTS `product_variants_fts`;
--> statement-breakpoint
CREATE VIEW `product_variants_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `sku` FROM `product_variants` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `product_variants_fts` USING fts5(
  `sku`,
  content='product_variants_fts_content',
  content_rowid='rowid'
);
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
WHEN EXISTS (SELECT 1 FROM `product_variants_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `product_variants_fts` (`product_variants_fts`, `rowid`, `sku`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.sku, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_update`
BEFORE UPDATE OF `sku` ON `product_variants`
WHEN (OLD.sku IS NOT NEW.sku)
  AND EXISTS (SELECT 1 FROM `product_variants_fts_docsize` WHERE `id` = OLD.`rowid`)
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
DROP TABLE IF EXISTS `pages_fts`;
--> statement-breakpoint
CREATE VIEW `pages_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `title`, coalesce(src.content_search_text, replace(replace(replace(replace(replace(substr(src.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))) AS `content` FROM `pages` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `pages_fts` USING fts5(
  `title`,
  `content`,
  content='pages_fts_content',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
--> statement-breakpoint
CREATE TRIGGER `pages_fts_after_insert`
AFTER INSERT ON `pages`
BEGIN
  INSERT INTO `pages_fts` (`rowid`, `title`, `content`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.content_search_text, replace(replace(replace(replace(replace(substr(NEW.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_delete`
BEFORE DELETE ON `pages`
WHEN EXISTS (SELECT 1 FROM `pages_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.content_search_text, replace(replace(replace(replace(replace(substr(OLD.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_update`
BEFORE UPDATE OF `title`, `content`, `content_search_text` ON `pages`
WHEN (OLD.title IS NOT NEW.title
  OR coalesce(OLD.content_search_text, substr(OLD.content, 1, 20000)) IS NOT coalesce(NEW.content_search_text, substr(NEW.content, 1, 20000)))
  AND EXISTS (SELECT 1 FROM `pages_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(OLD.content_search_text, replace(replace(replace(replace(replace(substr(OLD.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_after_update`
AFTER UPDATE OF `title`, `content`, `content_search_text` ON `pages`
WHEN OLD.title IS NOT NEW.title
  OR coalesce(OLD.content_search_text, substr(OLD.content, 1, 20000)) IS NOT coalesce(NEW.content_search_text, substr(NEW.content, 1, 20000))
BEGIN
  INSERT INTO `pages_fts` (`rowid`, `title`, `content`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), coalesce(NEW.content_search_text, replace(replace(replace(replace(replace(substr(NEW.content, 1, 20000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492))));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `orders_fts`;
--> statement-breakpoint
CREATE VIEW `orders_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `customer_name`, replace(replace(replace(replace(replace(substr(src.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `customer_phone`, replace(replace(replace(replace(replace(substr(src.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `customer_email`, replace(replace(replace(replace(replace(substr(src.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `id` FROM `orders` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `orders_fts` USING fts5(
  `customer_name`,
  `customer_phone`,
  `customer_email`,
  `id`,
  content='orders_fts_content',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
--> statement-breakpoint
CREATE TRIGGER `orders_fts_after_insert`
AFTER INSERT ON `orders`
BEGIN
  INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_before_delete`
BEFORE DELETE ON `orders`
WHEN EXISTS (SELECT 1 FROM `orders_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_before_update`
BEFORE UPDATE OF `customer_name`, `customer_phone`, `customer_email`, `id` ON `orders`
WHEN (OLD.customer_name IS NOT NEW.customer_name
  OR OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.customer_email IS NOT NEW.customer_email
  OR OLD.id IS NOT NEW.id)
  AND EXISTS (SELECT 1 FROM `orders_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `orders_fts` (`orders_fts`, `rowid`, `customer_name`, `customer_phone`, `customer_email`, `id`)
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
  INSERT INTO `orders_fts` (`rowid`, `customer_name`, `customer_phone`, `customer_email`, `id`)
  VALUES (NEW.`rowid`, replace(replace(replace(replace(replace(substr(NEW.customer_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.customer_email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(NEW.id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customers_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `customers_fts`;
--> statement-breakpoint
CREATE VIEW `customers_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `name`, replace(replace(replace(replace(replace(substr(src.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `phone`, replace(replace(replace(replace(replace(substr(src.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `email` FROM `customers` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `customers_fts` USING fts5(
  `name`,
  `phone`,
  `email`,
  content='customers_fts_content',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
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
WHEN EXISTS (SELECT 1 FROM `customers_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `customers_fts` (`customers_fts`, `rowid`, `name`, `phone`, `email`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.email, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `customers_fts_before_update`
BEFORE UPDATE OF `name`, `phone`, `email` ON `customers`
WHEN (OLD.name IS NOT NEW.name
  OR OLD.phone IS NOT NEW.phone
  OR OLD.email IS NOT NEW.email)
  AND EXISTS (SELECT 1 FROM `customers_fts_docsize` WHERE `id` = OLD.`rowid`)
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
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `abandoned_checkouts_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `abandoned_checkouts_fts`;
--> statement-breakpoint
CREATE VIEW `abandoned_checkouts_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `customer_phone`, replace(replace(replace(replace(replace(substr(src.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `checkout_id`, replace(replace(replace(replace(replace(substr(src.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `checkout_data` FROM `abandoned_checkouts` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `abandoned_checkouts_fts` USING fts5(
  `customer_phone`,
  `checkout_id`,
  `checkout_data`,
  content='abandoned_checkouts_fts_content',
  content_rowid='rowid'
);
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
WHEN EXISTS (SELECT 1 FROM `abandoned_checkouts_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `abandoned_checkouts_fts` (`abandoned_checkouts_fts`, `rowid`, `customer_phone`, `checkout_id`, `checkout_data`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.customer_phone, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.checkout_data, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `abandoned_checkouts_fts_before_update`
BEFORE UPDATE OF `customer_phone`, `checkout_id`, `checkout_data` ON `abandoned_checkouts`
WHEN (OLD.customer_phone IS NOT NEW.customer_phone
  OR OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.checkout_data IS NOT NEW.checkout_data)
  AND EXISTS (SELECT 1 FROM `abandoned_checkouts_fts_docsize` WHERE `id` = OLD.`rowid`)
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
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `navigation_menu_items_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `navigation_menu_items_fts`;
--> statement-breakpoint
CREATE VIEW `navigation_menu_items_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `label`, replace(replace(replace(replace(replace(substr(src.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `target_value`, replace(replace(replace(replace(replace(substr(src.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `target_id` FROM `navigation_menu_items` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `navigation_menu_items_fts` USING fts5(
  `label`,
  `target_value`,
  `target_id`,
  content='navigation_menu_items_fts_content',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
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
WHEN EXISTS (SELECT 1 FROM `navigation_menu_items_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `navigation_menu_items_fts` (`navigation_menu_items_fts`, `rowid`, `label`, `target_value`, `target_id`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.label, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_value, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.target_id, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_before_update`
BEFORE UPDATE OF `label`, `target_value`, `target_id` ON `navigation_menu_items`
WHEN (OLD.label IS NOT NEW.label
  OR OLD.target_value IS NOT NEW.target_value
  OR OLD.target_id IS NOT NEW.target_id)
  AND EXISTS (SELECT 1 FROM `navigation_menu_items_fts_docsize` WHERE `id` = OLD.`rowid`)
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
DROP TRIGGER IF EXISTS `product_reviews_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_reviews_fts_after_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `product_reviews_fts`;
--> statement-breakpoint
CREATE VIEW `product_reviews_fts_content` AS SELECT src.`rowid` AS `rowid`, replace(replace(replace(replace(replace(substr(src.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `title`, replace(replace(replace(replace(replace(substr(src.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `body`, replace(replace(replace(replace(replace(substr(src.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)) AS `author_display_name` FROM `product_reviews` AS src;
--> statement-breakpoint
CREATE VIRTUAL TABLE `product_reviews_fts` USING fts5(
  `title`,
  `body`,
  `author_display_name`,
  content='product_reviews_fts_content',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);
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
WHEN EXISTS (SELECT 1 FROM `product_reviews_fts_docsize` WHERE `id` = OLD.`rowid`)
BEGIN
  INSERT INTO `product_reviews_fts` (`product_reviews_fts`, `rowid`, `title`, `body`, `author_display_name`)
  VALUES ('delete', OLD.`rowid`, replace(replace(replace(replace(replace(substr(OLD.title, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.body, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)), replace(replace(replace(replace(replace(substr(OLD.author_display_name, 1, 2000), char(8204), ''), char(8205), ''), char(2524), char(2465) || char(2492)), char(2525), char(2466) || char(2492)), char(2527), char(2479) || char(2492)));
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_fts_before_update`
BEFORE UPDATE OF `title`, `body`, `author_display_name` ON `product_reviews`
WHEN (OLD.title IS NOT NEW.title
  OR OLD.body IS NOT NEW.body
  OR OLD.author_display_name IS NOT NEW.author_display_name)
  AND EXISTS (SELECT 1 FROM `product_reviews_fts_docsize` WHERE `id` = OLD.`rowid`)
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
INSERT INTO `settings` (`id`, `category`, `key`, `type`, `value`) SELECT 'maintenance:fts5-reindex', 'maintenance', 'fts5-reindex', 'json', '{}' WHERE EXISTS (SELECT 1 FROM `pages`) OR EXISTS (SELECT 1 FROM `orders`) OR EXISTS (SELECT 1 FROM `customers`) OR EXISTS (SELECT 1 FROM `abandoned_checkouts`) OR EXISTS (SELECT 1 FROM `navigation_menu_items`) OR EXISTS (SELECT 1 FROM `product_variants`) OR EXISTS (SELECT 1 FROM `product_reviews`) ON CONFLICT DO NOTHING;
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
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (219, '0219_search_plain_text_and_unicode_fold', '4fb65e3610d4205f929f985852d5b9ce21b2aaef104f4dafa5b9795d47d8a0bf');
