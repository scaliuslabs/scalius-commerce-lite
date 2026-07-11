-- SQLite cannot add a CHECK constraint without rebuilding the movement table.
-- Keep the rollout additive and preserve every legacy audit row; validate all
-- newly written ledger-v2 edges with triggers instead.
CREATE TRIGGER `inventory_movements_ledger_v2_insert_check`
BEFORE INSERT ON `inventory_movements`
FOR EACH ROW
WHEN NEW.`ledger_version` NOT IN (1, 2) OR (
    NEW.`ledger_version` = 2
    AND NOT (
        NEW.`pool` IN ('regular', 'preorder', 'backorder')
        AND NEW.`stock_version_before` IS NOT NULL
        AND NEW.`stock_version_after` = NEW.`stock_version_before` + 1
        AND NEW.`stock_delta` IS NOT NULL
        AND NEW.`previous_reserved_stock` IS NOT NULL
        AND NEW.`new_reserved_stock` IS NOT NULL
        AND NEW.`reserved_stock_delta` IS NOT NULL
        AND NEW.`previous_preorder_stock` IS NOT NULL
        AND NEW.`new_preorder_stock` IS NOT NULL
        AND NEW.`preorder_stock_delta` IS NOT NULL
        AND NEW.`new_stock` - NEW.`previous_stock` = NEW.`stock_delta`
        AND NEW.`new_reserved_stock` - NEW.`previous_reserved_stock` = NEW.`reserved_stock_delta`
        AND NEW.`new_preorder_stock` - NEW.`previous_preorder_stock` = NEW.`preorder_stock_delta`
        AND NEW.`previous_stock` >= 0
        AND NEW.`new_stock` >= 0
        AND NEW.`previous_reserved_stock` >= 0
        AND NEW.`new_reserved_stock` >= 0
        AND NEW.`previous_preorder_stock` >= 0
        AND NEW.`new_preorder_stock` >= 0
        AND (NEW.`reservation_generation` IS NULL OR NEW.`reservation_generation` >= 1)
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 movement');
END;

--> statement-breakpoint
CREATE TRIGGER `inventory_movements_ledger_v2_update_check`
BEFORE UPDATE ON `inventory_movements`
FOR EACH ROW
WHEN NEW.`ledger_version` NOT IN (1, 2) OR (
    NEW.`ledger_version` = 2
    AND NOT (
        NEW.`pool` IN ('regular', 'preorder', 'backorder')
        AND NEW.`stock_version_before` IS NOT NULL
        AND NEW.`stock_version_after` = NEW.`stock_version_before` + 1
        AND NEW.`stock_delta` IS NOT NULL
        AND NEW.`previous_reserved_stock` IS NOT NULL
        AND NEW.`new_reserved_stock` IS NOT NULL
        AND NEW.`reserved_stock_delta` IS NOT NULL
        AND NEW.`previous_preorder_stock` IS NOT NULL
        AND NEW.`new_preorder_stock` IS NOT NULL
        AND NEW.`preorder_stock_delta` IS NOT NULL
        AND NEW.`new_stock` - NEW.`previous_stock` = NEW.`stock_delta`
        AND NEW.`new_reserved_stock` - NEW.`previous_reserved_stock` = NEW.`reserved_stock_delta`
        AND NEW.`new_preorder_stock` - NEW.`previous_preorder_stock` = NEW.`preorder_stock_delta`
        AND NEW.`previous_stock` >= 0
        AND NEW.`new_stock` >= 0
        AND NEW.`previous_reserved_stock` >= 0
        AND NEW.`new_reserved_stock` >= 0
        AND NEW.`previous_preorder_stock` >= 0
        AND NEW.`new_preorder_stock` >= 0
        AND (NEW.`reservation_generation` IS NULL OR NEW.`reservation_generation` >= 1)
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 movement');
END;

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
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;

--> statement-breakpoint
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
)
BEGIN
    SELECT RAISE(ABORT, 'invalid inventory ledger v2 operation semantics');
END;
