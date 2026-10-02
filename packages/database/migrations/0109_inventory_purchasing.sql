-- Inventory operations: unit cost, suppliers, purchase orders, transfers.
-- product_variants.cost_minor is the SKU's current unit cost (staff-only) and
-- order_items.unit_cost_minor snapshots it when a line is created, so a later
-- cost change never rewrites past margins. Purchase orders receive stock with
-- `received` ledger-v2 movements; transfers move it with `transfer_out` at
-- the origin and `transfer_in` at the destination (or back at the origin on
-- cancel). Units in transit are out of both levels and out of the SKU's
-- stock, so sum(levels) = stock holds at every step and buyers never buy
-- them. inventory_commands is the operation-key replay ledger of these
-- multi-SKU commands; receipt and transfer movement links are immutable.
-- No backfill: existing rows keep NULL costs and no purchasing documents.
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`phone` text,
	`email` text,
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "suppliers_name_length" CHECK(length(trim("suppliers"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "suppliers_status_check" CHECK("suppliers"."status" IN ('active', 'archived')),
	CONSTRAINT "suppliers_text_lengths" CHECK(("suppliers"."contact_name" IS NULL OR length("suppliers"."contact_name") BETWEEN 1 AND 120) AND ("suppliers"."phone" IS NULL OR length("suppliers"."phone") BETWEEN 1 AND 32) AND ("suppliers"."email" IS NULL OR length("suppliers"."email") BETWEEN 3 AND 254) AND ("suppliers"."notes" IS NULL OR length("suppliers"."notes") BETWEEN 1 AND 2000)),
	CONSTRAINT "suppliers_version_positive" CHECK("suppliers"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `suppliers_status_name_idx` ON `suppliers` (`status`,`name`);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`supplier_id` text,
	`destination_location_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_on` text,
	`reference` text,
	`notes` text,
	`currency_code` text NOT NULL,
	`shipping_minor` integer DEFAULT 0 NOT NULL,
	`other_costs_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`ordered_at` integer,
	`received_at` integer,
	`cancelled_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "purchase_orders_number_positive" CHECK("purchase_orders"."number" >= 1),
	CONSTRAINT "purchase_orders_status_check" CHECK("purchase_orders"."status" IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
	CONSTRAINT "purchase_orders_costs_nonnegative" CHECK("purchase_orders"."shipping_minor" >= 0 AND "purchase_orders"."other_costs_minor" >= 0 AND "purchase_orders"."tax_minor" >= 0),
	CONSTRAINT "purchase_orders_revision_positive" CHECK("purchase_orders"."revision" >= 1),
	CONSTRAINT "purchase_orders_currency_code" CHECK(length("purchase_orders"."currency_code") = 3),
	CONSTRAINT "purchase_orders_expected_on" CHECK("purchase_orders"."expected_on" IS NULL OR length("purchase_orders"."expected_on") = 10),
	CONSTRAINT "purchase_orders_text_lengths" CHECK(("purchase_orders"."reference" IS NULL OR length("purchase_orders"."reference") BETWEEN 1 AND 100) AND ("purchase_orders"."notes" IS NULL OR length("purchase_orders"."notes") BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_number_unique` ON `purchase_orders` (`number`);
--> statement-breakpoint
CREATE INDEX `purchase_orders_status_created_idx` ON `purchase_orders` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `purchase_orders_supplier_idx` ON `purchase_orders` (`supplier_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `purchase_orders_destination_idx` ON `purchase_orders` (`destination_location_id`,`status`);
--> statement-breakpoint
CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`quantity` integer NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "purchase_order_lines_quantities" CHECK("purchase_order_lines"."quantity" >= 1 AND "purchase_order_lines"."received_quantity" >= 0 AND "purchase_order_lines"."received_quantity" <= "purchase_order_lines"."quantity"),
	CONSTRAINT "purchase_order_lines_unit_cost_nonnegative" CHECK("purchase_order_lines"."unit_cost_minor" >= 0),
	CONSTRAINT "purchase_order_lines_position_nonnegative" CHECK("purchase_order_lines"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_order_lines_order_variant_unique` ON `purchase_order_lines` (`purchase_order_id`,`variant_id`);
--> statement-breakpoint
CREATE INDEX `purchase_order_lines_variant_idx` ON `purchase_order_lines` (`variant_id`,`purchase_order_id`);
--> statement-breakpoint
CREATE TABLE `inventory_commands` (
	`operation_key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`command_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`result_payload` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "inventory_commands_type_check" CHECK("inventory_commands"."command_type" IN ('purchase_order_receive', 'transfer_ship', 'transfer_receive', 'transfer_cancel')),
	CONSTRAINT "inventory_commands_payload_json" CHECK(json_valid("inventory_commands"."result_payload"))
);
--> statement-breakpoint
CREATE INDEX `inventory_commands_subject_idx` ON `inventory_commands` (`subject_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `purchase_order_receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`cost_before_minor` integer,
	`cost_after_minor` integer,
	`cost_updated` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`operation_key`) REFERENCES `inventory_commands`(`operation_key`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "purchase_order_receipt_lines_quantity_positive" CHECK("purchase_order_receipt_lines"."quantity" >= 1),
	CONSTRAINT "purchase_order_receipt_lines_costs_nonnegative" CHECK("purchase_order_receipt_lines"."unit_cost_minor" >= 0 AND ("purchase_order_receipt_lines"."cost_before_minor" IS NULL OR "purchase_order_receipt_lines"."cost_before_minor" >= 0) AND ("purchase_order_receipt_lines"."cost_after_minor" IS NULL OR "purchase_order_receipt_lines"."cost_after_minor" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_order_receipt_lines_movement_unique` ON `purchase_order_receipt_lines` (`movement_id`);
--> statement-breakpoint
CREATE INDEX `purchase_order_receipt_lines_order_idx` ON `purchase_order_receipt_lines` (`purchase_order_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `purchase_order_receipt_lines_variant_idx` ON `purchase_order_receipt_lines` (`variant_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `inventory_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`origin_location_id` text NOT NULL,
	`destination_location_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_on` text,
	`reference` text,
	`notes` text,
	`shipped_at` integer,
	`received_at` integer,
	`cancelled_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`origin_location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "inventory_transfers_number_positive" CHECK("inventory_transfers"."number" >= 1),
	CONSTRAINT "inventory_transfers_locations_differ" CHECK("inventory_transfers"."origin_location_id" <> "inventory_transfers"."destination_location_id"),
	CONSTRAINT "inventory_transfers_status_check" CHECK("inventory_transfers"."status" IN ('draft', 'in_transit', 'partially_received', 'received', 'cancelled')),
	CONSTRAINT "inventory_transfers_revision_positive" CHECK("inventory_transfers"."revision" >= 1),
	CONSTRAINT "inventory_transfers_expected_on" CHECK("inventory_transfers"."expected_on" IS NULL OR length("inventory_transfers"."expected_on") = 10),
	CONSTRAINT "inventory_transfers_text_lengths" CHECK(("inventory_transfers"."reference" IS NULL OR length("inventory_transfers"."reference") BETWEEN 1 AND 100) AND ("inventory_transfers"."notes" IS NULL OR length("inventory_transfers"."notes") BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_transfers_number_unique` ON `inventory_transfers` (`number`);
--> statement-breakpoint
CREATE INDEX `inventory_transfers_status_created_idx` ON `inventory_transfers` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `inventory_transfers_origin_idx` ON `inventory_transfers` (`origin_location_id`,`status`);
--> statement-breakpoint
CREATE INDEX `inventory_transfers_destination_idx` ON `inventory_transfers` (`destination_location_id`,`status`);
--> statement-breakpoint
CREATE TABLE `inventory_transfer_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`quantity` integer NOT NULL,
	`shipped_quantity` integer DEFAULT 0 NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`returned_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `inventory_transfers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "inventory_transfer_lines_quantity_positive" CHECK("inventory_transfer_lines"."quantity" >= 1),
	CONSTRAINT "inventory_transfer_lines_progress" CHECK(("inventory_transfer_lines"."shipped_quantity" = 0 OR "inventory_transfer_lines"."shipped_quantity" = "inventory_transfer_lines"."quantity") AND "inventory_transfer_lines"."received_quantity" >= 0 AND "inventory_transfer_lines"."returned_quantity" >= 0 AND "inventory_transfer_lines"."received_quantity" + "inventory_transfer_lines"."returned_quantity" <= "inventory_transfer_lines"."shipped_quantity"),
	CONSTRAINT "inventory_transfer_lines_position_nonnegative" CHECK("inventory_transfer_lines"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_transfer_lines_transfer_variant_unique` ON `inventory_transfer_lines` (`transfer_id`,`variant_id`);
--> statement-breakpoint
CREATE INDEX `inventory_transfer_lines_variant_idx` ON `inventory_transfer_lines` (`variant_id`,`transfer_id`);
--> statement-breakpoint
CREATE TABLE `inventory_transfer_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`transfer_id` text NOT NULL,
	`transfer_line_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`kind` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`operation_key`) REFERENCES `inventory_commands`(`operation_key`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transfer_id`) REFERENCES `inventory_transfers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transfer_line_id`) REFERENCES `inventory_transfer_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "inventory_transfer_movements_kind_check" CHECK("inventory_transfer_movements"."kind" IN ('ship', 'receive', 'return')),
	CONSTRAINT "inventory_transfer_movements_quantity_positive" CHECK("inventory_transfer_movements"."quantity" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_transfer_movements_movement_unique` ON `inventory_transfer_movements` (`movement_id`);
--> statement-breakpoint
CREATE INDEX `inventory_transfer_movements_transfer_idx` ON `inventory_transfer_movements` (`transfer_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `cost_minor` integer;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `unit_cost_minor` integer;
--> statement-breakpoint
-- >>> 0109 inventory operations: triggers
-- Ledger v2 learns the receiving and transfer movements: physical stock at a
-- location, never reservations or preorder allocation. The update rule
-- keeps the 0102 shape (checked only when a movement's operation changes),
-- so rows written before 0065 and later notes edits still apply.
DROP TRIGGER IF EXISTS `inventory_movements_ledger_v2_insert_semantics`;
--> statement-breakpoint
CREATE TRIGGER `inventory_movements_ledger_v2_insert_semantics`
BEFORE INSERT ON `inventory_movements`
FOR EACH ROW
WHEN NEW.`ledger_version` = 2 AND NOT (
    (NEW.`type` = 'reserved'
        AND NEW.`pool` IN ('regular', 'backorder')
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'preorder_reserved'
        AND NEW.`pool` = 'preorder'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND NEW.`preorder_stock_delta` = -NEW.`quantity`)
    OR (NEW.`type` = 'released'
        AND NEW.`quantity` < 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND (
            (NEW.`pool` = 'preorder' AND NEW.`preorder_stock_delta` = -NEW.`quantity`)
            OR (NEW.`pool` IN ('regular', 'backorder') AND NEW.`preorder_stock_delta` = 0)
        ))
    OR (NEW.`type` = 'deducted'
        AND NEW.`pool` IN ('regular', 'backorder')
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = CASE WHEN NEW.`pool` = 'regular' THEN -NEW.`quantity` ELSE 0 END
        AND NEW.`reserved_stock_delta` = -NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'preorder_deducted'
        AND NEW.`pool` = 'preorder'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = -NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'restored'
        AND NEW.`quantity` > 0
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`stock_delta` = CASE WHEN NEW.`pool` = 'regular' THEN NEW.`quantity` ELSE 0 END
        AND NEW.`preorder_stock_delta` = CASE WHEN NEW.`pool` = 'preorder' THEN NEW.`quantity` ELSE 0 END)
    OR (NEW.`type` = 'adjusted'
        AND NEW.`reserved_stock_delta` = 0
        AND (
            (NEW.`pool` = 'regular' AND NEW.`stock_delta` = NEW.`quantity` AND NEW.`preorder_stock_delta` = 0)
            OR (NEW.`pool` = 'preorder' AND NEW.`stock_delta` = 0 AND NEW.`preorder_stock_delta` = NEW.`quantity`)
        ))
    OR (NEW.`type` IN ('received', 'transfer_in')
        AND NEW.`pool` = 'regular'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = NEW.`quantity`
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'transfer_out'
        AND NEW.`pool` = 'regular'
        AND NEW.`quantity` < 0
        AND NEW.`stock_delta` = NEW.`quantity`
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`preorder_stock_delta` = 0)
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `inventory_movements_ledger_v2_update_semantics`;
--> statement-breakpoint
CREATE TRIGGER `inventory_movements_ledger_v2_update_semantics`
BEFORE UPDATE ON `inventory_movements`
FOR EACH ROW
WHEN NEW.`ledger_version` = 2 AND (OLD.`ledger_version` IS NOT NEW.`ledger_version` OR OLD.`type` IS NOT NEW.`type` OR OLD.`pool` IS NOT NEW.`pool` OR OLD.`quantity` IS NOT NEW.`quantity` OR OLD.`stock_delta` IS NOT NEW.`stock_delta` OR OLD.`reserved_stock_delta` IS NOT NEW.`reserved_stock_delta` OR OLD.`preorder_stock_delta` IS NOT NEW.`preorder_stock_delta`) AND NOT (
    (NEW.`type` = 'reserved'
        AND NEW.`pool` IN ('regular', 'backorder')
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'preorder_reserved'
        AND NEW.`pool` = 'preorder'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND NEW.`preorder_stock_delta` = -NEW.`quantity`)
    OR (NEW.`type` = 'released'
        AND NEW.`quantity` < 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = NEW.`quantity`
        AND (
            (NEW.`pool` = 'preorder' AND NEW.`preorder_stock_delta` = -NEW.`quantity`)
            OR (NEW.`pool` IN ('regular', 'backorder') AND NEW.`preorder_stock_delta` = 0)
        ))
    OR (NEW.`type` = 'deducted'
        AND NEW.`pool` IN ('regular', 'backorder')
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = CASE WHEN NEW.`pool` = 'regular' THEN -NEW.`quantity` ELSE 0 END
        AND NEW.`reserved_stock_delta` = -NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'preorder_deducted'
        AND NEW.`pool` = 'preorder'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = 0
        AND NEW.`reserved_stock_delta` = -NEW.`quantity`
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'restored'
        AND NEW.`quantity` > 0
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`stock_delta` = CASE WHEN NEW.`pool` = 'regular' THEN NEW.`quantity` ELSE 0 END
        AND NEW.`preorder_stock_delta` = CASE WHEN NEW.`pool` = 'preorder' THEN NEW.`quantity` ELSE 0 END)
    OR (NEW.`type` = 'adjusted'
        AND NEW.`reserved_stock_delta` = 0
        AND (
            (NEW.`pool` = 'regular' AND NEW.`stock_delta` = NEW.`quantity` AND NEW.`preorder_stock_delta` = 0)
            OR (NEW.`pool` = 'preorder' AND NEW.`stock_delta` = 0 AND NEW.`preorder_stock_delta` = NEW.`quantity`)
        ))
    OR (NEW.`type` IN ('received', 'transfer_in')
        AND NEW.`pool` = 'regular'
        AND NEW.`quantity` > 0
        AND NEW.`stock_delta` = NEW.`quantity`
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`preorder_stock_delta` = 0)
    OR (NEW.`type` = 'transfer_out'
        AND NEW.`pool` = 'regular'
        AND NEW.`quantity` < 0
        AND NEW.`stock_delta` = NEW.`quantity`
        AND NEW.`reserved_stock_delta` = 0
        AND NEW.`preorder_stock_delta` = 0)
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;
--> statement-breakpoint
-- A SKU's unit cost is NULL or a whole, non-negative safe number of minor units.
CREATE TRIGGER `product_variants_cost_guard_insert`
BEFORE INSERT ON `product_variants`
WHEN NEW.`cost_minor` IS NOT NULL AND (NEW.`cost_minor` < 0 OR NEW.`cost_minor` > 9007199254740991 OR NEW.`cost_minor` <> CAST(NEW.`cost_minor` AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_VARIANT_COST_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_cost_guard_update`
BEFORE UPDATE OF `cost_minor` ON `product_variants`
WHEN NEW.`cost_minor` IS NOT NULL AND (NEW.`cost_minor` < 0 OR NEW.`cost_minor` > 9007199254740991 OR NEW.`cost_minor` <> CAST(NEW.`cost_minor` AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_VARIANT_COST_INVALID');
END;
--> statement-breakpoint
-- Every new order line, whichever path creates it (checkout, staff orders,
-- amendments), records its SKU's unit cost at that moment; NULL when the SKU
-- has none. Once recorded it never changes.
CREATE TRIGGER `order_items_unit_cost_snapshot`
AFTER INSERT ON `order_items`
WHEN NEW.`unit_cost_minor` IS NULL AND NEW.`variant_id` IS NOT NULL
BEGIN
  UPDATE `order_items` SET `unit_cost_minor` = (SELECT `cost_minor` FROM `product_variants` WHERE `id` = NEW.`variant_id`) WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_unit_cost_immutable`
BEFORE UPDATE OF `unit_cost_minor` ON `order_items`
WHEN OLD.`unit_cost_minor` IS NOT NULL AND NEW.`unit_cost_minor` IS NOT OLD.`unit_cost_minor`
BEGIN
  SELECT RAISE(ABORT, 'order line unit cost is frozen at creation');
END;
--> statement-breakpoint
-- Lines of an ordered (or later) purchase order are what was ordered: only
-- received quantities move, and only up.
CREATE TRIGGER `purchase_order_lines_insert_draft_only`
BEFORE INSERT ON `purchase_order_lines`
WHEN EXISTS (SELECT 1 FROM `purchase_orders` AS po WHERE po.`id` = NEW.`purchase_order_id` AND po.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ORDER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `purchase_order_lines_update_locked`
BEFORE UPDATE ON `purchase_order_lines`
WHEN (NEW.`purchase_order_id` IS NOT OLD.`purchase_order_id` OR NEW.`variant_id` IS NOT OLD.`variant_id` OR NEW.`quantity` IS NOT OLD.`quantity` OR NEW.`unit_cost_minor` IS NOT OLD.`unit_cost_minor`)
  AND EXISTS (SELECT 1 FROM `purchase_orders` AS po WHERE po.`id` = OLD.`purchase_order_id` AND po.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ORDER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `purchase_order_lines_delete_draft_only`
BEFORE DELETE ON `purchase_order_lines`
WHEN EXISTS (SELECT 1 FROM `purchase_orders` AS po WHERE po.`id` = OLD.`purchase_order_id` AND po.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ORDER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `purchase_order_lines_received_monotonic`
BEFORE UPDATE OF `received_quantity` ON `purchase_order_lines`
WHEN NEW.`received_quantity` < OLD.`received_quantity`
BEGIN
  SELECT RAISE(ABORT, 'received quantities never decrease');
END;
--> statement-breakpoint
-- Transfer lines likewise: fixed once shipped; progress only moves up.
CREATE TRIGGER `inventory_transfer_lines_insert_draft_only`
BEFORE INSERT ON `inventory_transfer_lines`
WHEN EXISTS (SELECT 1 FROM `inventory_transfers` AS t WHERE t.`id` = NEW.`transfer_id` AND t.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_TRANSFER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_transfer_lines_update_locked`
BEFORE UPDATE ON `inventory_transfer_lines`
WHEN (NEW.`transfer_id` IS NOT OLD.`transfer_id` OR NEW.`variant_id` IS NOT OLD.`variant_id` OR NEW.`quantity` IS NOT OLD.`quantity`)
  AND EXISTS (SELECT 1 FROM `inventory_transfers` AS t WHERE t.`id` = OLD.`transfer_id` AND t.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_TRANSFER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_transfer_lines_delete_draft_only`
BEFORE DELETE ON `inventory_transfer_lines`
WHEN EXISTS (SELECT 1 FROM `inventory_transfers` AS t WHERE t.`id` = OLD.`transfer_id` AND t.`status` <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_TRANSFER_LINES_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_transfer_lines_progress_monotonic`
BEFORE UPDATE OF `shipped_quantity`, `received_quantity`, `returned_quantity` ON `inventory_transfer_lines`
WHEN NEW.`shipped_quantity` < OLD.`shipped_quantity` OR NEW.`received_quantity` < OLD.`received_quantity` OR NEW.`returned_quantity` < OLD.`returned_quantity`
BEGIN
  SELECT RAISE(ABORT, 'transfer progress never decreases');
END;
--> statement-breakpoint
-- Replay records, cost history and transfer movement links are append-only.
CREATE TRIGGER `inventory_commands_update_blocked`
BEFORE UPDATE ON `inventory_commands`
BEGIN
  SELECT RAISE(ABORT, 'inventory commands are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_commands_delete_blocked`
BEFORE DELETE ON `inventory_commands`
BEGIN
  SELECT RAISE(ABORT, 'inventory commands are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `purchase_order_receipt_lines_update_blocked`
BEFORE UPDATE ON `purchase_order_receipt_lines`
BEGIN
  SELECT RAISE(ABORT, 'purchase order receipts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `purchase_order_receipt_lines_delete_blocked`
BEFORE DELETE ON `purchase_order_receipt_lines`
BEGIN
  SELECT RAISE(ABORT, 'purchase order receipts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_transfer_movements_update_blocked`
BEFORE UPDATE ON `inventory_transfer_movements`
BEGIN
  SELECT RAISE(ABORT, 'transfer movements are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_transfer_movements_delete_blocked`
BEFORE DELETE ON `inventory_transfer_movements`
BEGIN
  SELECT RAISE(ABORT, 'transfer movements are immutable');
END;
--> statement-breakpoint
-- inventory.purchase_order_updated and inventory.transfer_updated (event-outbox-triggers.ts, generated).
CREATE TRIGGER `evt_purchase_orders_created` AFTER INSERT ON `purchase_orders`
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_changed` AFTER UPDATE ON `purchase_orders`
WHEN (OLD.`revision` IS NOT NEW.`revision`)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_deleted` AFTER DELETE ON `purchase_orders`
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', OLD.`id`, json_object('purchaseOrderId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_created` AFTER INSERT ON `inventory_transfers`
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_changed` AFTER UPDATE ON `inventory_transfers`
WHEN (OLD.`revision` IS NOT NEW.`revision`)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_deleted` AFTER DELETE ON `inventory_transfers`
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', OLD.`id`, json_object('transferId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
-- <<< 0109
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (109, '0109_inventory_purchasing', '79ffcab6ba85f5285d4fbf9029a42ce82ea1d23845bfd3742465646904cff740');
