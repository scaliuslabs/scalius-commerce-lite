-- The warranty handover is one trigger again. 0215 split W1 in two, a period
-- revision's and a lifetime revision's, to keep CASE out of the body (remote
-- D1 rule): each line handed over then ran two guards, each reading the
-- line's item and revision. One trigger guards on the item's frozen revision
-- (one read, as 0098 did) and leaves a lifetime record's end empty through a
-- scalar subquery that has no row for a lifetime revision.
DROP TRIGGER IF EXISTS `order_fulfillment_lines_lifetime_warranty_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `order_fulfillment_lines_warranty_insert`;
--> statement-breakpoint
-- W1: one warranty per handed-over fulfilment line of a line with a frozen
-- revision; a period ends by the revision's duration, a lifetime never.
CREATE TRIGGER `order_fulfillment_lines_warranty_insert`
AFTER INSERT ON `order_fulfillment_lines`
WHEN (SELECT i.`warranty_revision_id` FROM `order_items` AS i WHERE i.`id` = NEW.`order_item_id`) IS NOT NULL
BEGIN
  INSERT INTO `order_item_warranties` (`id`, `order_id`, `order_item_id`, `fulfillment_id`, `fulfillment_line_id`, `revision_id`, `quantity`, `starts_at`, `expires_at`, `replacement_until`)
  SELECT 'wty_' || NEW.`id`, NEW.`order_id`, NEW.`order_item_id`, NEW.`fulfillment_id`, NEW.`id`, r.`id`, NEW.`quantity`, f.`created_at`,
    (SELECT unixepoch(f.`created_at`, 'unixepoch', '+' || r.`duration_value` || ' ' || r.`duration_unit`) WHERE r.`lifetime` = 0),
    f.`created_at` + r.`replacement_days` * 86400
  FROM `order_items` AS i
  JOIN `warranty_policy_revisions` AS r ON r.`id` = i.`warranty_revision_id`
  JOIN `order_fulfillments` AS f ON f.`id` = NEW.`fulfillment_id`
  WHERE i.`id` = NEW.`order_item_id`;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (217, '0217_warranty_handover_one_trigger', '5f7c0bfdd64867c6c352b7438a0781f681cb37aa30684d7595355e0d5b73626b');
