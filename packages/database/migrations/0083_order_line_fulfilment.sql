-- Order-line fulfilment (Wave A §2, §5.2). Expand-only: the API that is live
-- while this migrates keeps working. Variants gain a fulfilment kind and
-- products a gift-card flag; orders gain requires_shipping, the delivery
-- method kind and pickup snapshots, and their address becomes nullable
-- (required by trigger only when something ships). Order lines gain a frozen
-- fulfilment type and fulfilled_quantity, the projection of a new append-only
-- fulfilment ledger. Every historical line is `ship`, and every shipped unit
-- is backfilled into the ledger before its projection triggers exist.
ALTER TABLE `product_variants` ADD `fulfillment_kind` text DEFAULT 'physical' NOT NULL CONSTRAINT `product_variants_fulfillment_kind_check` CHECK (`fulfillment_kind` IN ('physical', 'digital', 'service'));
--> statement-breakpoint
DROP TRIGGER `product_variants_checkout_authority_update`;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_authority_update`
AFTER UPDATE ON `product_variants`
WHEN NEW.`product_id` IS NOT OLD.`product_id`
  OR NEW.`option_combination_key` IS NOT OLD.`option_combination_key`
  OR NEW.`image_id` IS NOT OLD.`image_id`
  OR NEW.`price_minor` IS NOT OLD.`price_minor`
  OR NEW.`is_default` IS NOT OLD.`is_default`
  OR NEW.`track_inventory` IS NOT OLD.`track_inventory`
  OR NEW.`allow_preorder` IS NOT OLD.`allow_preorder`
  OR NEW.`allow_backorder` IS NOT OLD.`allow_backorder`
  OR NEW.`backorder_limit` IS NOT OLD.`backorder_limit`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
  OR NEW.`discount_bps` IS NOT OLD.`discount_bps`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
  OR NEW.`fulfillment_kind` IS NOT OLD.`fulfillment_kind`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
ALTER TABLE `products` ADD `is_gift_card` integer DEFAULT 0 NOT NULL CONSTRAINT `products_is_gift_card_check` CHECK (`is_gift_card` IN (0, 1));
--> statement-breakpoint
DROP TRIGGER `products_checkout_authority_update`;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_authority_update`
AFTER UPDATE ON `products`
WHEN NEW.`name` IS NOT OLD.`name`
  OR NEW.`price_minor` IS NOT OLD.`price_minor`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
  OR NEW.`is_active` IS NOT OLD.`is_active`
  OR NEW.`discount_bps` IS NOT OLD.`discount_bps`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor`
  OR NEW.`free_delivery` IS NOT OLD.`free_delivery`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
  OR NEW.`is_gift_card` IS NOT OLD.`is_gift_card`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
ALTER TABLE `orders` ADD `requires_shipping` integer DEFAULT 1 NOT NULL CONSTRAINT `orders_requires_shipping_check` CHECK (`requires_shipping` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_method_kind` text CONSTRAINT `orders_shipping_method_kind_check` CHECK (`shipping_method_kind` IS NULL OR `shipping_method_kind` IN ('delivery', 'pickup'));
--> statement-breakpoint
ALTER TABLE `orders` ADD `pickup_address` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `pickup_hours` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `pickup_ready_at` integer;
--> statement-breakpoint
-- The address becomes nullable through rename/add/copy/drop: rebuilding
-- orders would cascade-delete its children, and no index or trigger reads
-- these columns.
ALTER TABLE `orders` RENAME COLUMN `shipping_address` TO `_old_shipping_address`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `city` TO `_old_city`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `zone` TO `_old_zone`;
--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_address` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `city` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `zone` text;
--> statement-breakpoint
UPDATE `orders` SET
  `shipping_address` = `_old_shipping_address`,
  `city` = `_old_city`,
  `zone` = `_old_zone`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_shipping_address`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_city`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_zone`;
--> statement-breakpoint
CREATE TRIGGER `orders_shipping_address_required_insert`
BEFORE INSERT ON `orders`
WHEN NEW.`requires_shipping` = 1
  AND (NEW.`shipping_address` IS NULL OR trim(NEW.`shipping_address`) = '' OR NEW.`city` IS NULL OR NEW.`zone` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'shipping address required');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_shipping_address_required_update`
BEFORE UPDATE OF `requires_shipping`, `shipping_address`, `city`, `zone` ON `orders`
WHEN NEW.`requires_shipping` = 1
  AND (NEW.`shipping_address` IS NULL OR trim(NEW.`shipping_address`) = '' OR NEW.`city` IS NULL OR NEW.`zone` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'shipping address required');
END;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `fulfillment_type` text DEFAULT 'ship' NOT NULL CONSTRAINT `order_items_fulfillment_type_check` CHECK (`fulfillment_type` IN ('ship', 'pickup', 'digital', 'gift_card', 'service'));
--> statement-breakpoint
ALTER TABLE `order_items` ADD `fulfilled_quantity` integer DEFAULT 0 NOT NULL CONSTRAINT `order_items_fulfilled_quantity_bounds` CHECK (`fulfilled_quantity` >= 0 AND `fulfilled_quantity` <= `quantity`);
--> statement-breakpoint
CREATE TRIGGER `order_items_fulfillment_type_immutable`
BEFORE UPDATE OF `fulfillment_type` ON `order_items`
WHEN NEW.`fulfillment_type` IS NOT OLD.`fulfillment_type`
BEGIN
  SELECT RAISE(ABORT, 'order line fulfilment type is immutable');
END;
--> statement-breakpoint
CREATE TABLE `order_fulfillments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`shipment_id` text,
	`request_key` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`cash_collected_minor` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`voided_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shipment_id`) REFERENCES `delivery_shipments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_fulfillments_kind_check" CHECK("order_fulfillments"."kind" IN ('ship', 'pickup', 'digital', 'gift_card', 'service')),
	CONSTRAINT "order_fulfillments_status_check" CHECK("order_fulfillments"."status" IN ('active', 'voided')),
	CONSTRAINT "order_fulfillments_void_shape" CHECK(("order_fulfillments"."status" = 'active' AND "order_fulfillments"."voided_at" IS NULL) OR ("order_fulfillments"."status" = 'voided' AND "order_fulfillments"."voided_at" IS NOT NULL)),
	CONSTRAINT "order_fulfillments_actor_type_check" CHECK("order_fulfillments"."actor_type" IN ('admin', 'system')),
	CONSTRAINT "order_fulfillments_request_key_length" CHECK(length(trim("order_fulfillments"."request_key")) BETWEEN 1 AND 200),
	CONSTRAINT "order_fulfillments_cash_nonnegative" CHECK("order_fulfillments"."cash_collected_minor" IS NULL OR "order_fulfillments"."cash_collected_minor" >= 0),
	CONSTRAINT "order_fulfillments_shipment_is_ship" CHECK("order_fulfillments"."shipment_id" IS NULL OR "order_fulfillments"."kind" = 'ship')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_fulfillments_order_request_key_unique` ON `order_fulfillments` (`order_id`,`request_key`);
--> statement-breakpoint
CREATE INDEX `order_fulfillments_order_created_idx` ON `order_fulfillments` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_fulfillments_shipment_unique` ON `order_fulfillments` (`shipment_id`) WHERE "order_fulfillments"."shipment_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `order_fulfillment_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`fulfillment_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`fulfillment_id`) REFERENCES `order_fulfillments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_fulfillment_lines_quantity_positive" CHECK("order_fulfillment_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_fulfillment_lines_fulfillment_item_unique` ON `order_fulfillment_lines` (`fulfillment_id`,`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_fulfillment_lines_order_item_idx` ON `order_fulfillment_lines` (`order_item_id`);
--> statement-breakpoint
CREATE INDEX `order_fulfillment_lines_order_idx` ON `order_fulfillment_lines` (`order_id`);
--> statement-breakpoint
-- Backfill: one system `ship` fulfilment per order that has sent units, with
-- one line per sent order line, then the projection. The ledger triggers are
-- created after this so the backfill is not projected twice.
INSERT INTO `order_fulfillments` (`id`, `order_id`, `kind`, `status`, `request_key`, `actor_type`, `created_at`)
SELECT 'ful_mig_' || o.`id`, o.`id`, 'ship', 'active', 'migration:0083', 'system', o.`updated_at`
FROM `orders` AS o
WHERE EXISTS (
  SELECT 1 FROM `order_items` AS oi
  WHERE oi.`order_id` = o.`id` AND oi.`shipped_quantity` > 0
);
--> statement-breakpoint
INSERT INTO `order_fulfillment_lines` (`id`, `fulfillment_id`, `order_id`, `order_item_id`, `quantity`, `created_at`)
SELECT 'fln_mig_' || oi.`id`, 'ful_mig_' || oi.`order_id`, oi.`order_id`, oi.`id`, min(oi.`shipped_quantity`, oi.`quantity`), o.`updated_at`
FROM `order_items` AS oi
JOIN `orders` AS o ON o.`id` = oi.`order_id`
WHERE oi.`shipped_quantity` > 0;
--> statement-breakpoint
UPDATE `order_items` SET `fulfilled_quantity` = min(`shipped_quantity`, `quantity`)
WHERE `shipped_quantity` > 0;
--> statement-breakpoint
-- F2: a line joins an active fulfilment of the same order and type, and never
-- takes the line past its quantity.
CREATE TRIGGER `order_fulfillment_lines_match_insert`
BEFORE INSERT ON `order_fulfillment_lines`
WHEN NOT EXISTS (
  SELECT 1
  FROM `order_fulfillments` AS f
  JOIN `order_items` AS oi ON oi.`id` = NEW.`order_item_id`
  WHERE f.`id` = NEW.`fulfillment_id`
    AND f.`order_id` = NEW.`order_id`
    AND oi.`order_id` = NEW.`order_id`
    AND f.`status` = 'active'
    AND oi.`fulfillment_type` = f.`kind`
)
BEGIN
  SELECT RAISE(ABORT, 'fulfilment line must match an active fulfilment of the same order and type');
END;
--> statement-breakpoint
CREATE TRIGGER `order_fulfillment_lines_bounds_insert`
BEFORE INSERT ON `order_fulfillment_lines`
WHEN NOT EXISTS (
  SELECT 1 FROM `order_items` AS oi
  WHERE oi.`id` = NEW.`order_item_id`
    AND oi.`fulfilled_quantity` + NEW.`quantity` <= oi.`quantity`
)
BEGIN
  SELECT RAISE(ABORT, 'fulfilment exceeds the unfulfilled line quantity');
END;
--> statement-breakpoint
-- F1: fulfilled_quantity is the sum of active ledger lines.
CREATE TRIGGER `order_fulfillment_lines_project_insert`
AFTER INSERT ON `order_fulfillment_lines`
BEGIN
  UPDATE `order_items` SET `fulfilled_quantity` = `fulfilled_quantity` + NEW.`quantity` WHERE `id` = NEW.`order_item_id`;
END;
--> statement-breakpoint
-- F3: the ledger is append-only; a fulfilment only moves active -> voided.
CREATE TRIGGER `order_fulfillment_lines_update_blocked`
BEFORE UPDATE ON `order_fulfillment_lines`
BEGIN
  SELECT RAISE(ABORT, 'fulfilment lines are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `order_fulfillment_lines_delete_blocked`
BEFORE DELETE ON `order_fulfillment_lines`
BEGIN
  SELECT RAISE(ABORT, 'fulfilment lines are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `order_fulfillments_update_guard`
BEFORE UPDATE ON `order_fulfillments`
WHEN NOT (
  OLD.`status` = 'active'
  AND NEW.`status` = 'voided'
  AND NEW.`id` IS OLD.`id`
  AND NEW.`order_id` IS OLD.`order_id`
  AND NEW.`kind` IS OLD.`kind`
  AND NEW.`shipment_id` IS OLD.`shipment_id`
  AND NEW.`request_key` IS OLD.`request_key`
  AND NEW.`actor_type` IS OLD.`actor_type`
  AND NEW.`actor_id` IS OLD.`actor_id`
  AND NEW.`cash_collected_minor` IS OLD.`cash_collected_minor`
  AND NEW.`created_at` IS OLD.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'fulfilments are immutable except active to voided');
END;
--> statement-breakpoint
CREATE TRIGGER `order_fulfillments_delete_blocked`
BEFORE DELETE ON `order_fulfillments`
BEGIN
  SELECT RAISE(ABORT, 'fulfilments are durable order evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `order_fulfillments_project_void`
AFTER UPDATE OF `status` ON `order_fulfillments`
WHEN OLD.`status` = 'active' AND NEW.`status` = 'voided'
BEGIN
  UPDATE `order_items` SET `fulfilled_quantity` = `fulfilled_quantity` - (
    SELECT coalesce(sum(l.`quantity`), 0) FROM `order_fulfillment_lines` AS l
    WHERE l.`fulfillment_id` = NEW.`id` AND l.`order_item_id` = `order_items`.`id`
  )
  WHERE `id` IN (SELECT `order_item_id` FROM `order_fulfillment_lines` WHERE `fulfillment_id` = NEW.`id`);
END;
--> statement-breakpoint
-- F12: returns come only from physically handed-over lines and are bounded by
-- what was handed over. Until the contract migration drops the legacy line
-- columns, a line the previous API marked shipped/delivered stays returnable
-- up to its quantity, exactly as before.
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
      AND (oi.fulfilled_quantity > 0 OR oi.fulfillment_status IN ('shipped', 'delivered'))
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
    SELECT max(oi.fulfilled_quantity, CASE WHEN oi.fulfillment_status IN ('shipped', 'delivered') THEN oi.quantity ELSE 0 END)
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
      ), 0) > max(oi.fulfilled_quantity, CASE WHEN oi.fulfillment_status IN ('shipped', 'delivered') THEN oi.quantity ELSE 0 END)
)
BEGIN
    SELECT RAISE(ABORT, 'cumulative return quantity exceeds fulfilled item quantity');
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (83, '0083_order_line_fulfilment', '03d720537b4e7efef98e38074a3c474b2caeaf6b8cdc71c3ca84a63ac5024d19');
