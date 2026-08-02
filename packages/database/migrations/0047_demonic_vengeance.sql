CREATE TABLE `checkout_inventory_lane_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`pool` text NOT NULL,
	`lane` integer NOT NULL,
	`operation` text NOT NULL,
	`quantity` integer NOT NULL,
	`lane_capacity_before` integer NOT NULL,
	`lane_reserved_before` integer NOT NULL,
	`lane_reserved_after` integer NOT NULL,
	`lane_version_before` integer NOT NULL,
	`lane_version_after` integer NOT NULL,
	`source_stock_version_before` integer NOT NULL,
	`source_stock_version_after` integer NOT NULL,
	`stock_before` integer NOT NULL,
	`stock_after` integer NOT NULL,
	`legacy_reserved_stock_before` integer NOT NULL,
	`legacy_reserved_stock_after` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "checkout_inventory_lane_movements_shape_check" CHECK("checkout_inventory_lane_movements"."pool" = 'regular'
            AND "checkout_inventory_lane_movements"."lane" BETWEEN 0 AND 31
            AND "checkout_inventory_lane_movements"."operation" IN ('released', 'deducted')
            AND "checkout_inventory_lane_movements"."quantity" > 0
            AND "checkout_inventory_lane_movements"."lane_capacity_before" >= 0
            AND "checkout_inventory_lane_movements"."lane_reserved_before" >= "checkout_inventory_lane_movements"."quantity"
            AND "checkout_inventory_lane_movements"."lane_reserved_after" = "checkout_inventory_lane_movements"."lane_reserved_before" - "checkout_inventory_lane_movements"."quantity"
            AND "checkout_inventory_lane_movements"."lane_version_before" >= 0
            AND "checkout_inventory_lane_movements"."lane_version_after" = "checkout_inventory_lane_movements"."lane_version_before" + 1
            AND "checkout_inventory_lane_movements"."source_stock_version_before" >= 1
            AND "checkout_inventory_lane_movements"."source_stock_version_after" = "checkout_inventory_lane_movements"."source_stock_version_before"
                + CASE WHEN "checkout_inventory_lane_movements"."operation" = 'deducted' THEN 1 ELSE 0 END
            AND "checkout_inventory_lane_movements"."stock_before" >= 0
            AND "checkout_inventory_lane_movements"."stock_after" = "checkout_inventory_lane_movements"."stock_before"
                - CASE WHEN "checkout_inventory_lane_movements"."operation" = 'deducted' THEN "checkout_inventory_lane_movements"."quantity" ELSE 0 END
            AND "checkout_inventory_lane_movements"."legacy_reserved_stock_before" >= 0
            AND "checkout_inventory_lane_movements"."legacy_reserved_stock_after" = "checkout_inventory_lane_movements"."legacy_reserved_stock_before")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_inventory_lane_movements_edge_uidx` ON `checkout_inventory_lane_movements` (`order_id`,`variant_id`,`pool`,`lane`);--> statement-breakpoint
CREATE INDEX `checkout_inventory_lane_movements_variant_idx` ON `checkout_inventory_lane_movements` (`variant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `checkout_inventory_lane_movements_order_idx` ON `checkout_inventory_lane_movements` (`order_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `inventory_authority` text DEFAULT 'legacy_counter' NOT NULL;--> statement-breakpoint
CREATE TRIGGER `orders_inventory_authority_insert_guard`
BEFORE INSERT ON `orders`
WHEN
  NEW.`inventory_authority` NOT IN ('legacy_counter', 'checkout_lane_v1')
  OR (
    NEW.`inventory_authority` = 'checkout_lane_v1'
    AND (
      NEW.`checkout_aggregate_version` IS NOT 1
      OR NEW.`inventory_action` <> 'reserved'
      OR NOT json_valid(NEW.`checkout_inventory_edges`)
      OR json_array_length(NEW.`checkout_inventory_edges`) < 1
    )
  )
  OR (
    NEW.`checkout_aggregate_version` = 1
    AND NEW.`inventory_action` = 'reserved'
    AND json_valid(NEW.`checkout_inventory_edges`)
    AND json_array_length(NEW.`checkout_inventory_edges`) > 0
    AND NEW.`inventory_authority` <> 'checkout_lane_v1'
  )
BEGIN
  SELECT RAISE(ABORT, 'ORDER_INVENTORY_AUTHORITY_INVALID');
END;--> statement-breakpoint
CREATE TRIGGER `orders_inventory_authority_update_guard`
BEFORE UPDATE OF `inventory_authority` ON `orders`
WHEN
  NEW.`inventory_authority` NOT IN ('legacy_counter', 'checkout_lane_v1')
  OR (
    NEW.`inventory_authority` IS NOT OLD.`inventory_authority`
    AND NOT (
      OLD.`inventory_authority` = 'checkout_lane_v1'
      AND NEW.`inventory_authority` = 'legacy_counter'
      AND OLD.`checkout_aggregate_version` = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ORDER_INVENTORY_AUTHORITY_TRANSITION_INVALID');
END;--> statement-breakpoint
DROP TRIGGER `inventory_movements_ledger_v2_insert_semantics`;--> statement-breakpoint
DROP TRIGGER `inventory_movements_ledger_v2_update_semantics`;--> statement-breakpoint
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
        AND (
            NEW.`reserved_stock_delta` = -NEW.`quantity`
            OR (
                NEW.`pool` = 'regular'
                AND NEW.`reserved_stock_delta` = 0
                AND EXISTS (
                    SELECT 1
                    FROM `checkout_inventory_lane_movements` AS lane_edge
                    WHERE lane_edge.`order_id` IS NEW.`order_id`
                      AND lane_edge.`variant_id` = NEW.`variant_id`
                      AND lane_edge.`pool` = NEW.`pool`
                      AND lane_edge.`operation` = 'deducted'
                      AND lane_edge.`quantity` = NEW.`quantity`
                      AND lane_edge.`source_stock_version_before` = NEW.`stock_version_before`
                      AND lane_edge.`source_stock_version_after` = NEW.`stock_version_after`
                )
            )
        )
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
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;--> statement-breakpoint
CREATE TRIGGER `inventory_movements_ledger_v2_update_semantics`
BEFORE UPDATE ON `inventory_movements`
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
        AND (
            NEW.`reserved_stock_delta` = -NEW.`quantity`
            OR (
                NEW.`pool` = 'regular'
                AND NEW.`reserved_stock_delta` = 0
                AND EXISTS (
                    SELECT 1
                    FROM `checkout_inventory_lane_movements` AS lane_edge
                    WHERE lane_edge.`order_id` IS NEW.`order_id`
                      AND lane_edge.`variant_id` = NEW.`variant_id`
                      AND lane_edge.`pool` = NEW.`pool`
                      AND lane_edge.`operation` = 'deducted'
                      AND lane_edge.`quantity` = NEW.`quantity`
                      AND lane_edge.`source_stock_version_before` = NEW.`stock_version_before`
                      AND lane_edge.`source_stock_version_after` = NEW.`stock_version_after`
                )
            )
        )
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
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;
