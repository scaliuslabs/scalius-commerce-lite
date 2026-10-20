-- A limited promotion's redemptions advance its cache key (promo:<id>) only
-- when one exhausts it: the redemption count reaches max_redemptions, or the
-- discount spend reaches max_discount_spend_minor (the evaluator's rule). A
-- removed redemption advances it only when it un-exhausts the promotion.
-- Every other redemption leaves the pages that show the promotion cached, so
-- a flash sale is not re-rendered after every order. The guard is the
-- trigger's WHEN clause (generated from packages/shared/src/cache-deps.ts by
-- packages/database/scripts/cache-dep-triggers.ts). Triggers only.
DROP TRIGGER IF EXISTS `cdep_promotion_redemptions_ins`;
--> statement-breakpoint
CREATE TRIGGER `cdep_promotion_redemptions_ins` AFTER INSERT ON `promotion_redemptions`
WHEN EXISTS (SELECT 1 FROM promotions WHERE promotions.id = NEW.promotion_id AND (promotions.max_redemptions IS NOT NULL OR promotions.max_discount_spend_minor IS NOT NULL) AND ((promotions.max_redemptions IS NOT NULL AND (SELECT count(*) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) = promotions.max_redemptions) OR (promotions.max_discount_spend_minor IS NOT NULL AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) >= promotions.max_discount_spend_minor AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) - NEW.discount_amount_minor < promotions.max_discount_spend_minor)))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || NEW.`promotion_id`, 't:promotion_redemptions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_promotion_redemptions_del`;
--> statement-breakpoint
CREATE TRIGGER `cdep_promotion_redemptions_del` AFTER DELETE ON `promotion_redemptions`
WHEN EXISTS (SELECT 1 FROM promotions WHERE promotions.id = OLD.promotion_id AND (promotions.max_redemptions IS NOT NULL OR promotions.max_discount_spend_minor IS NOT NULL) AND ((promotions.max_redemptions IS NOT NULL AND (SELECT count(*) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) + 1 = promotions.max_redemptions) OR (promotions.max_discount_spend_minor IS NOT NULL AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) < promotions.max_discount_spend_minor AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) + OLD.discount_amount_minor >= promotions.max_discount_spend_minor)))
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('promo:' || OLD.`promotion_id`, 't:promotion_redemptions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (167, '0167_promotion_exhaustion_dependency', '32cbe7582a9e1aa23dbf5e5dfba735ce9f4e7462d3f4e85ddd1ff9f10e6d8f3e');
