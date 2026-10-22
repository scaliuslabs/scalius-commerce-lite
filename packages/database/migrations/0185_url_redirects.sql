-- URL redirects (merchant QA M2): an old storefront address that leads to
-- another, written when a product's URL handle changes (on by default) or
-- added by hand under Online store -> Navigation -> URL redirects. The
-- storefront looks one up only when a path answers 404, so no page that
-- exists reads it. Buyer-visible: every change advances `rd`
-- (`@scalius/shared/cache-deps`, generated triggers below).
CREATE TABLE `url_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`from_path` text NOT NULL,
	`to_path` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "url_redirects_paths" CHECK(substr("from_path", 1, 1) = '/' AND substr("to_path", 1, 1) = '/' AND "from_path" <> "to_path")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `url_redirects_from_path_unique` ON `url_redirects` (`from_path`);
--> statement-breakpoint
CREATE INDEX `url_redirects_to_path_idx` ON `url_redirects` (`to_path`);
--> statement-breakpoint
CREATE TRIGGER `cdep_url_redirects_ins` AFTER INSERT ON `url_redirects`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('rd', 't:url_redirects')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_url_redirects_del` AFTER DELETE ON `url_redirects`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('rd', 't:url_redirects')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_url_redirects_upd` AFTER UPDATE ON `url_redirects`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`from_path` IS NOT NEW.`from_path` OR OLD.`to_path` IS NOT NEW.`to_path`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('rd', 't:url_redirects')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (185, '0185_url_redirects', '13670fb5240828ba6920b7341b8a9ec78294cf1ee48698749e3338b750ecb327');
