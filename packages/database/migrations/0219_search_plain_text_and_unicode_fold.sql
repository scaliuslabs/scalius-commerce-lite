-- Search reads text, folded as FTS5 folds it, on every provider.
-- D1: products_fts and pages_fts index a description's or a page's text, not
-- its markup (tag and attribute names matched searches): their four triggers
-- read the column through searchHtmlTextSql, then each table is emptied and
-- every row indexed again. Both keep their external content (the rows hold
-- the markup): never run FTS5's 'rebuild' on them.
-- Turso: the marker expands into the search index's refresh
-- (search-index.ts, searchIndexSqliteRefreshStatements): the fold table (every
-- Basic Multilingual Plane character FTS5 folds, Cyrillic and Greek case
-- included, where the replace() chains covered Latin-1 and nested too deep
-- for libSQL's parser), every trigger again, and the index rebuilt.
-- External providers upgrade under the verified write freeze.
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
  VALUES (NEW.`rowid`, NEW.`name`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(NEW.`description`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_before_delete`
BEFORE DELETE ON `products`
BEGIN
  INSERT INTO `products_fts` (`products_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, OLD.`name`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(OLD.`description`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_before_update`
BEFORE UPDATE ON `products`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`name` IS NOT NEW.`name`
  OR OLD.`description` IS NOT NEW.`description`
BEGIN
  INSERT INTO `products_fts` (`products_fts`, `rowid`, `name`, `description`)
  VALUES ('delete', OLD.`rowid`, OLD.`name`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(OLD.`description`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `products_fts_after_update`
AFTER UPDATE ON `products`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`name` IS NOT NEW.`name`
  OR OLD.`description` IS NOT NEW.`description`
BEGIN
  INSERT INTO `products_fts` (`rowid`, `name`, `description`)
  VALUES (NEW.`rowid`, NEW.`name`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(NEW.`description`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
INSERT INTO `products_fts` (`products_fts`) VALUES ('delete-all');
--> statement-breakpoint
INSERT INTO `products_fts` (`rowid`, `name`, `description`) SELECT `rowid`, src.`name`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(src.`description`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ') FROM `products` AS src;
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
  VALUES (NEW.`rowid`, NEW.`title`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(NEW.`content`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_delete`
BEFORE DELETE ON `pages`
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content_col`)
  VALUES ('delete', OLD.`rowid`, OLD.`title`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(OLD.`content`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_before_update`
BEFORE UPDATE ON `pages`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`title` IS NOT NEW.`title`
  OR OLD.`content` IS NOT NEW.`content`
BEGIN
  INSERT INTO `pages_fts` (`pages_fts`, `rowid`, `title`, `content_col`)
  VALUES ('delete', OLD.`rowid`, OLD.`title`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(OLD.`content`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_after_update`
AFTER UPDATE ON `pages`
WHEN OLD.`rowid` IS NOT NEW.`rowid`
  OR OLD.`title` IS NOT NEW.`title`
  OR OLD.`content` IS NOT NEW.`content`
BEGIN
  INSERT INTO `pages_fts` (`rowid`, `title`, `content_col`)
  VALUES (NEW.`rowid`, NEW.`title`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(NEW.`content`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' '));
END;
--> statement-breakpoint
INSERT INTO `pages_fts` (`pages_fts`) VALUES ('delete-all');
--> statement-breakpoint
INSERT INTO `pages_fts` (`rowid`, `title`, `content_col`) SELECT `rowid`, src.`title`, replace(replace(replace(replace(replace(replace(replace(replace(replace((SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(src.`content`), '<', '","') || ']') AS piece), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ') FROM `pages` AS src;
--> statement-breakpoint
SELECT 'search_fts_terms:refresh';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (219, '0219_search_plain_text_and_unicode_fold', 'ae5057a085c42c01a6fe3af3db5cc91798043ca7d4f15904e4781b7e1a06fbff');
