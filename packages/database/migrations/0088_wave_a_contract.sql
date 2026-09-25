-- Wave A contract, step 1 (Wave A §5.6). The API that ran while 0083 was
-- deploying still counted sent units in order_items.shipped_quantity without
-- writing the fulfilment ledger. Those units are recorded first, as 0083 did:
-- per ship line, what the legacy counter says left minus what 0083 already
-- migrated (fln_mig_<line>, active or voided, so a parcel voided since is not
-- sent again), capped by what is still unfulfilled; one system fulfilment per
-- order, and the ledger triggers project fulfilled_quantity. Returns are then
-- bounded by the ledger alone, and the tables Wave A replaced are dropped.
-- The legacy line, parcel and case-message columns are dropped by 0089, one
-- release later: the API that is live while this migrates still reads them.
CREATE TABLE `_wave_a_contract_gap` AS
SELECT `order_item_id`, `order_id`, `quantity`
FROM (
  SELECT
    oi.`id` AS `order_item_id`,
    oi.`order_id` AS `order_id`,
    min(
      min(oi.`shipped_quantity`, oi.`quantity`) - coalesce((
        SELECT l.`quantity` FROM `order_fulfillment_lines` AS l
        WHERE l.`id` = 'fln_mig_' || oi.`id`
      ), 0),
      oi.`quantity` - oi.`fulfilled_quantity`
    ) AS `quantity`
  FROM `order_items` AS oi
  WHERE oi.`fulfillment_type` = 'ship' AND oi.`shipped_quantity` > 0
) AS gap
WHERE gap.`quantity` > 0;
--> statement-breakpoint
INSERT INTO `order_fulfillments` (`id`, `order_id`, `kind`, `status`, `request_key`, `actor_type`, `created_at`)
SELECT 'ful_mig2_' || o.`id`, o.`id`, 'ship', 'active', 'migration:0088', 'system', o.`updated_at`
FROM `orders` AS o
WHERE o.`id` IN (SELECT `order_id` FROM `_wave_a_contract_gap`);
--> statement-breakpoint
INSERT INTO `order_fulfillment_lines` (`id`, `fulfillment_id`, `order_id`, `order_item_id`, `quantity`, `created_at`)
SELECT 'fln_mig2_' || gap.`order_item_id`, 'ful_mig2_' || gap.`order_id`, gap.`order_id`, gap.`order_item_id`, gap.`quantity`, o.`updated_at`
FROM `_wave_a_contract_gap` AS gap
JOIN `orders` AS o ON o.`id` = gap.`order_id`;
--> statement-breakpoint
DROP TABLE `_wave_a_contract_gap`;
--> statement-breakpoint
-- F12: returns come only from physically handed-over lines and are bounded
-- by what the ledger says was handed over; the legacy line status no longer
-- counts.
DROP TRIGGER `order_return_lines_validate_insert`;
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_validate_insert`
BEFORE INSERT ON `order_return_lines`
WHEN NOT EXISTS (
    SELECT 1
    FROM `order_items` oi
    JOIN `order_returns` r ON r.id = NEW.return_id
    WHERE oi.id = NEW.order_item_id
      AND oi.order_id = NEW.order_id
      AND r.order_id = NEW.order_id
      AND oi.fulfillment_type IN ('ship', 'pickup')
      AND oi.fulfilled_quantity > 0
      AND (NEW.inventory_tracked = 0 OR (NEW.variant_id IS NOT NULL AND NEW.variant_id = oi.variant_id))
)
BEGIN
    SELECT RAISE(ABORT, 'return line must reference a shipped item in the same order');
END;
--> statement-breakpoint
DROP TRIGGER `order_return_lines_entitlement_insert`;
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_entitlement_insert`
BEFORE INSERT ON `order_return_lines`
WHEN (
    COALESCE((
        SELECT SUM(CASE
            WHEN r.status = 'requested' THEN rl.requested_quantity
            WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
            ELSE 0
        END)
        FROM `order_return_lines` rl
        JOIN `order_returns` r ON r.id = rl.return_id
        WHERE rl.order_item_id = NEW.order_item_id
    ), 0) + NEW.requested_quantity
) > (
    SELECT oi.fulfilled_quantity
    FROM `order_items` oi WHERE oi.id = NEW.order_item_id
)
BEGIN
    SELECT RAISE(ABORT, 'cumulative return quantity exceeds fulfilled item quantity');
END;
--> statement-breakpoint
DROP TRIGGER `order_returns_entitlement_status_update`;
--> statement-breakpoint
CREATE TRIGGER `order_returns_entitlement_status_update`
BEFORE UPDATE OF status ON `order_returns`
WHEN EXISTS (
    SELECT 1
    FROM `order_items` oi
    WHERE oi.order_id = NEW.order_id
      AND COALESCE((
          SELECT SUM(CASE
              WHEN r.id = NEW.id THEN CASE
                  WHEN NEW.status = 'requested' THEN rl.requested_quantity
                  WHEN NEW.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
                  ELSE 0
              END
              WHEN r.status = 'requested' THEN rl.requested_quantity
              WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
              ELSE 0
          END)
          FROM `order_return_lines` rl
          JOIN `order_returns` r ON r.id = rl.return_id
          WHERE rl.order_item_id = oi.id
      ), 0) > oi.fulfilled_quantity
)
BEGIN
    SELECT RAISE(ABORT, 'cumulative return quantity exceeds fulfilled item quantity');
END;
--> statement-breakpoint
-- Replaced by notification_outbox / notification_delivery_receipts (0086)
-- and by the order thread (0085). Receipts reference the outbox: drop first.
DROP TABLE `order_notification_delivery_receipts`;
--> statement-breakpoint
DROP TABLE `order_notification_outbox`;
--> statement-breakpoint
DROP TABLE `order_support_request_events`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (88, '0088_wave_a_contract', 'e7d67648b6beea33bc539e988256fc0e1b378be208b42b27272e8560c4b495a2');
