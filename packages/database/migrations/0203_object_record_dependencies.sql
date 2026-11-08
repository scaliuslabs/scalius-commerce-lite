-- A filtered public object read (an app component's reviews of the product
-- on the page) depends on its type's own row and on the records its filter
-- string leads, not on every record of the type: a published record also
-- advances obj:<type_id>:<lead> for each index slot led by a string (the
-- slot's first tuple component, index-encoding.ts), and a public type also
-- advances obj:<id>:type. The type's indexes are visible now (a filtered
-- read finds its slot by them). Triggers only, generated from
-- packages/shared/src/cache-deps.ts by packages/database/scripts/cache-dep-triggers.ts.
DROP TRIGGER IF EXISTS `cdep_object_types_ins`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_ins` AFTER INSERT ON `object_types`
WHEN NEW.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`id`, 'obj:' || NEW.`id` || ':type', 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_types_del`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_del` AFTER DELETE ON `object_types`
WHEN OLD.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`id`, 'obj:' || OLD.`id` || ':type', 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_types_upd`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_upd` AFTER UPDATE ON `object_types`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`namespace` IS NOT NEW.`namespace` OR OLD.`type` IS NOT NEW.`type` OR OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`fields_json` IS NOT NEW.`fields_json` OR OLD.`indexes_json` IS NOT NEW.`indexes_json` OR OLD.`display_field` IS NOT NEW.`display_field` OR OLD.`storefront` IS NOT NEW.`storefront` OR OLD.`handle` IS NOT NEW.`handle`)
  AND NEW.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`id`, 'obj:' || NEW.`id` || ':type', 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_types_upd_old`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_upd_old` AFTER UPDATE ON `object_types`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`storefront` IS NOT NEW.`storefront`)
  AND OLD.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`id`, 'obj:' || OLD.`id` || ':type', 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_records_ins`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_ins` AFTER INSERT ON `object_records`
WHEN NEW.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`type_id`, 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k1`, nullif(instr(substr(NEW.`k1`, 1, 2), '05'), 0), nullif(instr(NEW.`k1`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k2`, nullif(instr(substr(NEW.`k2`, 1, 2), '05'), 0), nullif(instr(NEW.`k2`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k3`, nullif(instr(substr(NEW.`k3`, 1, 2), '05'), 0), nullif(instr(NEW.`k3`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k4`, nullif(instr(substr(NEW.`k4`, 1, 2), '05'), 0), nullif(instr(NEW.`k4`, '0001'), 0) + 3), 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_records_del`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_del` AFTER DELETE ON `object_records`
WHEN OLD.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`type_id`, 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k1`, nullif(instr(substr(OLD.`k1`, 1, 2), '05'), 0), nullif(instr(OLD.`k1`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k2`, nullif(instr(substr(OLD.`k2`, 1, 2), '05'), 0), nullif(instr(OLD.`k2`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k3`, nullif(instr(substr(OLD.`k3`, 1, 2), '05'), 0), nullif(instr(OLD.`k3`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k4`, nullif(instr(substr(OLD.`k4`, 1, 2), '05'), 0), nullif(instr(OLD.`k4`, '0001'), 0) + 3), 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_records_upd`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_upd` AFTER UPDATE ON `object_records`
WHEN (OLD.`type_id` IS NOT NEW.`type_id` OR OLD.`id` IS NOT NEW.`id` OR OLD.`handle` IS NOT NEW.`handle` OR OLD.`status` IS NOT NEW.`status` OR OLD.`data_json` IS NOT NEW.`data_json` OR OLD.`k1` IS NOT NEW.`k1` OR OLD.`k2` IS NOT NEW.`k2` OR OLD.`k3` IS NOT NEW.`k3` OR OLD.`k4` IS NOT NEW.`k4` OR OLD.`pub` IS NOT NEW.`pub` OR OLD.`position` IS NOT NEW.`position`)
  AND NEW.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`type_id`, 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k1`, nullif(instr(substr(NEW.`k1`, 1, 2), '05'), 0), nullif(instr(NEW.`k1`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k2`, nullif(instr(substr(NEW.`k2`, 1, 2), '05'), 0), nullif(instr(NEW.`k2`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k3`, nullif(instr(substr(NEW.`k3`, 1, 2), '05'), 0), nullif(instr(NEW.`k3`, '0001'), 0) + 3), 'obj:' || NEW.`type_id` || ':' || substr(NEW.`k4`, nullif(instr(substr(NEW.`k4`, 1, 2), '05'), 0), nullif(instr(NEW.`k4`, '0001'), 0) + 3), 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_object_records_upd_old`;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_upd_old` AFTER UPDATE ON `object_records`
WHEN (OLD.`type_id` IS NOT NEW.`type_id` OR OLD.`k1` IS NOT NEW.`k1` OR OLD.`k2` IS NOT NEW.`k2` OR OLD.`k3` IS NOT NEW.`k3` OR OLD.`k4` IS NOT NEW.`k4` OR OLD.`pub` IS NOT NEW.`pub`)
  AND OLD.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`type_id`, 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k1`, nullif(instr(substr(OLD.`k1`, 1, 2), '05'), 0), nullif(instr(OLD.`k1`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k2`, nullif(instr(substr(OLD.`k2`, 1, 2), '05'), 0), nullif(instr(OLD.`k2`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k3`, nullif(instr(substr(OLD.`k3`, 1, 2), '05'), 0), nullif(instr(OLD.`k3`, '0001'), 0) + 3), 'obj:' || OLD.`type_id` || ':' || substr(OLD.`k4`, nullif(instr(substr(OLD.`k4`, 1, 2), '05'), 0), nullif(instr(OLD.`k4`, '0001'), 0) + 3), 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (203, '0203_object_record_dependencies', 'f5f3ca8852fe6abd5174b16bf3ac78714f9323f5c628e19cc4920082a09c2e09');
