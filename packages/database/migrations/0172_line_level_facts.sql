-- Line-level facts (COMMERCE-HOOKS H3): fulfilment events list the order lines
-- they handed over, and refunds become records with lines.
--   order_refunds: one row per refund command (its id is the attempts'
--     refund_group_id); status is maintained from its attempts by triggers:
--     pending until each settles, then refunded, failed or partial.
--   order_refund_lines: the order lines a refund is for, append-only, at most
--     each line's quantity across refunds that did not fail.
-- Event triggers (scripts/event-outbox-triggers.ts): order.fulfilled,
-- fulfillment.created and fulfillment.voided gain `lines`; the lines a
-- fulfilment writes after it amend its pending events; refund.created fires
-- on a refund's first attempt and refund.updated on each status change.
-- Existing refunds get a record without lines; pending fulfilment events get
-- their lines. No CASE in any trigger body (remote D1 rule).
CREATE TABLE `order_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`settlement` text DEFAULT 'original' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_refunds_status_check" CHECK("order_refunds"."status" IN ('pending', 'refunded', 'failed', 'partial')),
	CONSTRAINT "order_refunds_settlement_check" CHECK("order_refunds"."settlement" IN ('original', 'store_credit')),
	CONSTRAINT "order_refunds_amount_nonnegative" CHECK("order_refunds"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `order_refunds_order_created_idx` ON `order_refunds` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `order_refund_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`refund_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `order_refunds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_refund_lines_quantity_positive" CHECK("order_refund_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_refund_lines_refund_item_unique` ON `order_refund_lines` (`refund_id`,`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_refund_lines_order_item_idx` ON `order_refund_lines` (`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_refund_lines_order_idx` ON `order_refund_lines` (`order_id`);
--> statement-breakpoint
INSERT INTO `order_refunds` (`id`, `order_id`, `status`, `currency`, `amount_minor`, `settlement`, `created_at`, `updated_at`)
SELECT `refund_group_id`, min(`order_id`),
  CASE
    WHEN sum(CASE WHEN `status` IN ('refunded', 'failed', 'cancelled') THEN 0 ELSE 1 END) > 0 THEN 'pending'
    WHEN sum(CASE WHEN `status` = 'refunded' THEN 1 ELSE 0 END) = count(*) THEN 'refunded'
    WHEN sum(CASE WHEN `status` = 'refunded' THEN 1 ELSE 0 END) = 0 THEN 'failed'
    ELSE 'partial'
  END,
  min(`currency`), sum(`amount_minor`),
  CASE WHEN sum(CASE WHEN json_extract(`metadata`, '$.settlementMode') = 'store_credit' THEN 1 ELSE 0 END) > 0 THEN 'store_credit' ELSE 'original' END,
  min(`created_at`), max(`updated_at`)
FROM `refund_attempts`
GROUP BY `refund_group_id`;
--> statement-breakpoint
CREATE TRIGGER `order_refunds_settled_refunded`
AFTER UPDATE OF `status` ON `refund_attempts`
WHEN NEW.`status` IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM `refund_attempts` AS `sibling` WHERE `sibling`.`refund_group_id` = NEW.`refund_group_id` AND `sibling`.`status` <> 'refunded')
BEGIN
  UPDATE `order_refunds` SET `status` = 'refunded', `updated_at` = cast(strftime('%s','now') as int) WHERE `id` = NEW.`refund_group_id` AND `status` <> 'refunded';
END;
--> statement-breakpoint
CREATE TRIGGER `order_refunds_settled_failed`
AFTER UPDATE OF `status` ON `refund_attempts`
WHEN NEW.`status` IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM `refund_attempts` AS `sibling` WHERE `sibling`.`refund_group_id` = NEW.`refund_group_id` AND `sibling`.`status` NOT IN ('failed', 'cancelled'))
BEGIN
  UPDATE `order_refunds` SET `status` = 'failed', `updated_at` = cast(strftime('%s','now') as int) WHERE `id` = NEW.`refund_group_id` AND `status` <> 'failed';
END;
--> statement-breakpoint
CREATE TRIGGER `order_refunds_settled_partial`
AFTER UPDATE OF `status` ON `refund_attempts`
WHEN NEW.`status` IN ('refunded', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM `refund_attempts` AS `sibling` WHERE `sibling`.`refund_group_id` = NEW.`refund_group_id` AND `sibling`.`status` NOT IN ('refunded', 'failed', 'cancelled'))
  AND EXISTS (SELECT 1 FROM `refund_attempts` AS `sibling` WHERE `sibling`.`refund_group_id` = NEW.`refund_group_id` AND `sibling`.`status` = 'refunded')
  AND EXISTS (SELECT 1 FROM `refund_attempts` AS `sibling` WHERE `sibling`.`refund_group_id` = NEW.`refund_group_id` AND `sibling`.`status` IN ('failed', 'cancelled'))
BEGIN
  UPDATE `order_refunds` SET `status` = 'partial', `updated_at` = cast(strftime('%s','now') as int) WHERE `id` = NEW.`refund_group_id` AND `status` <> 'partial';
END;
--> statement-breakpoint
CREATE TRIGGER `order_refund_lines_match_insert`
BEFORE INSERT ON `order_refund_lines`
WHEN NOT EXISTS (
  SELECT 1 FROM `order_items` AS `item`
  INNER JOIN `order_refunds` AS `refund` ON `refund`.`id` = NEW.`refund_id`
  WHERE `item`.`id` = NEW.`order_item_id` AND `item`.`order_id` = NEW.`order_id` AND `refund`.`order_id` = NEW.`order_id`
)
BEGIN
  SELECT RAISE(ABORT, 'refund line is not a line of the refund order');
END;
--> statement-breakpoint
CREATE TRIGGER `order_refund_lines_bounds_insert`
BEFORE INSERT ON `order_refund_lines`
WHEN NOT EXISTS (
  SELECT 1 FROM `order_items` AS `item`
  WHERE `item`.`id` = NEW.`order_item_id`
    AND NEW.`quantity` + (
      SELECT coalesce(sum(`line`.`quantity`), 0) FROM `order_refund_lines` AS `line`
      INNER JOIN `order_refunds` AS `refund` ON `refund`.`id` = `line`.`refund_id`
      WHERE `line`.`order_item_id` = NEW.`order_item_id` AND `refund`.`status` <> 'failed'
    ) <= `item`.`quantity`
)
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds the line quantity');
END;
--> statement-breakpoint
CREATE TRIGGER `order_refund_lines_update_blocked`
BEFORE UPDATE ON `order_refund_lines`
BEGIN
  SELECT RAISE(ABORT, 'refund lines are immutable');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_fulfillments_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_fulfillments_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_fulfillments_voided;
--> statement-breakpoint
CREATE TRIGGER `evt_order_fulfillments_created` AFTER INSERT ON `order_fulfillments`
WHEN NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.fulfilled', 'order', NEW.`order_id`, json_object('orderId', NEW.`order_id`, 'fulfillmentId', NEW.`id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`, 'lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_fulfillment_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`fulfillment_id` = NEW.`id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_fulfillments_created` AFTER INSERT ON `order_fulfillments`
WHEN NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'fulfillment.created', 'fulfillment', NEW.`id`, json_object('fulfillmentId', NEW.`id`, 'orderId', NEW.`order_id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`, 'lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_fulfillment_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`fulfillment_id` = NEW.`id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_fulfillments_voided` AFTER UPDATE ON `order_fulfillments`
WHEN (OLD.`status` = 'active' AND NEW.`status` = 'voided') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.voided'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'fulfillment.voided', 'fulfillment', NEW.`id`, json_object('fulfillmentId', NEW.`id`, 'orderId', NEW.`order_id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`, 'lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_fulfillment_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`fulfillment_id` = NEW.`id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_refunds_created` AFTER INSERT ON `refund_attempts`
WHEN NEW.`allocation_index` = 0 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'refund.*', 'refund.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'refund.created', 'refund', NEW.`refund_group_id`, json_object('refundId', NEW.`refund_group_id`, 'orderId', NEW.`order_id`, 'status', (SELECT `status` FROM `order_refunds` WHERE `id` = NEW.`refund_group_id`), 'lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_refund_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`refund_id` = NEW.`refund_group_id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_refunds_updated` AFTER UPDATE ON `order_refunds`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'refund.*', 'refund.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'refund.updated', 'refund', NEW.`id`, json_object('refundId', NEW.`id`, 'orderId', NEW.`order_id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_refund_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`refund_id` = NEW.`id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_fulfillment_lines_facts` AFTER INSERT ON `order_fulfillment_lines`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled', 'fulfillment.*', 'fulfillment.created'))
BEGIN
  UPDATE `event_outbox` SET `data` = json_set(`data`, '$.lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_fulfillment_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`fulfillment_id` = NEW.`fulfillment_id` ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`))) WHERE `resource_type` IN ('order', 'fulfillment') AND `resource_id` IN (NEW.`order_id`, NEW.`fulfillment_id`) AND `topic` IN ('order.fulfilled', 'fulfillment.created') AND `status` = 'pending' AND json_extract(`data`, '$.fulfillmentId') = NEW.`fulfillment_id`;
END;
--> statement-breakpoint
UPDATE `event_outbox` SET `data` = json_set(`data`, '$.lines', json((SELECT json_group_array(json(`line`.`fact`)) FROM (SELECT json_object('orderItemId', `ledger`.`order_item_id`, 'variantId', `item`.`variant_id`, 'quantity', `ledger`.`quantity`) AS `fact`, `ledger`.`order_item_id` AS `line_order` FROM `order_fulfillment_lines` AS `ledger` LEFT JOIN `order_items` AS `item` ON `item`.`id` = `ledger`.`order_item_id` WHERE `ledger`.`fulfillment_id` = json_extract(`event_outbox`.`data`, '$.fulfillmentId') ORDER BY `ledger`.`order_item_id` LIMIT 500) AS `line`)))
WHERE `topic` IN ('order.fulfilled', 'fulfillment.created', 'fulfillment.voided') AND json_type(`data`, '$.lines') IS NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (172, '0172_line_level_facts', '13db61f89364d479edb68cf5d86a6bc954f4100e201fb254ddf99c6d6cb641a3');