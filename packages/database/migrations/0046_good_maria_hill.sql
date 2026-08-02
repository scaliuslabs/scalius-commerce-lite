CREATE TABLE `checkout_batch_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`order_ids` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `checkout_batch_outbox_pending_idx` ON `checkout_batch_outbox` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `inventory_reservation_lanes` (
	`variant_id` text NOT NULL,
	`pool` text NOT NULL,
	`lane` integer NOT NULL,
	`capacity` integer,
	`reserved_quantity` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`source_stock_version` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`variant_id`, `pool`, `lane`),
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_reservation_lanes_pool_check" CHECK("inventory_reservation_lanes"."pool" IN ('regular', 'preorder', 'backorder')),
	CONSTRAINT "inventory_reservation_lanes_lane_check" CHECK("inventory_reservation_lanes"."lane" BETWEEN 0 AND 31),
	CONSTRAINT "inventory_reservation_lanes_reserved_check" CHECK("inventory_reservation_lanes"."reserved_quantity" >= 0),
	CONSTRAINT "inventory_reservation_lanes_capacity_check" CHECK("inventory_reservation_lanes"."capacity" IS NULL OR ("inventory_reservation_lanes"."capacity" >= 0 AND "inventory_reservation_lanes"."reserved_quantity" <= "inventory_reservation_lanes"."capacity")),
	CONSTRAINT "inventory_reservation_lanes_finite_pool_check" CHECK("inventory_reservation_lanes"."pool" = 'backorder' OR "inventory_reservation_lanes"."capacity" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `inventory_reservation_lanes_pool_idx` ON `inventory_reservation_lanes` (`pool`,`variant_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_request_key` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_request_hash` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_receipt_hash` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_aggregate_version` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_aggregate_payload` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_inventory_edges` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_response_payload` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_projection_status` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_projection_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_checkout_request_key_unique` ON `orders` (`checkout_request_key`) WHERE "orders"."checkout_request_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_checkout_receipt_hash_unique` ON `orders` (`checkout_receipt_hash`) WHERE "orders"."checkout_receipt_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_checkout_projection_idx` ON `orders` (`checkout_projection_status`,`created_at`) WHERE "orders"."checkout_projection_status" IS NOT NULL AND "orders"."checkout_projection_status" <> 'complete';
--> statement-breakpoint
CREATE TRIGGER `orders_checkout_aggregate_shape_guard`
BEFORE INSERT ON `orders`
WHEN (
  NEW.`checkout_request_key` IS NOT NULL
  OR NEW.`checkout_request_hash` IS NOT NULL
  OR NEW.`checkout_receipt_hash` IS NOT NULL
  OR NEW.`checkout_aggregate_version` IS NOT NULL
  OR NEW.`checkout_aggregate_payload` IS NOT NULL
  OR NEW.`checkout_inventory_edges` IS NOT NULL
  OR NEW.`checkout_response_payload` IS NOT NULL
  OR NEW.`checkout_projection_status` IS NOT NULL
) AND (
  NEW.`checkout_aggregate_version` IS NOT 1
  OR trim(coalesce(NEW.`checkout_request_key`, '')) = ''
  OR trim(coalesce(NEW.`checkout_request_hash`, '')) = ''
  OR trim(coalesce(NEW.`checkout_receipt_hash`, '')) = ''
  OR NOT json_valid(NEW.`checkout_aggregate_payload`)
  OR NOT json_valid(NEW.`checkout_inventory_edges`)
  OR NOT json_valid(NEW.`checkout_response_payload`)
  OR json_type(NEW.`checkout_aggregate_payload`) <> 'object'
  OR json_type(NEW.`checkout_inventory_edges`) <> 'array'
  OR json_type(NEW.`checkout_response_payload`) <> 'object'
  OR CAST(json_extract(NEW.`checkout_aggregate_payload`, '$.schemaVersion') AS INTEGER) IS NOT 1
  OR json_extract(NEW.`checkout_aggregate_payload`, '$.payload.orderData.id') IS NOT NEW.`id`
  OR json_extract(NEW.`checkout_aggregate_payload`, '$.checkout.requestKey') IS NOT NEW.`checkout_request_key`
  OR json_extract(NEW.`checkout_aggregate_payload`, '$.checkout.requestHash') IS NOT NEW.`checkout_request_hash`
  OR json_extract(NEW.`checkout_aggregate_payload`, '$.checkout.receiptHash') IS NOT NEW.`checkout_receipt_hash`
  OR CAST(json_extract(NEW.`checkout_aggregate_payload`, '$.payload.orderData.totalAmountMinor') AS INTEGER)
     IS NOT NEW.`total_amount_minor`
  OR NEW.`checkout_projection_status` NOT IN ('pending', 'complete')
)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_AGGREGATE_SHAPE_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_checkout_aggregate_immutable_guard`
BEFORE UPDATE OF
  `checkout_request_key`,
  `checkout_request_hash`,
  `checkout_receipt_hash`,
  `checkout_aggregate_version`,
  `checkout_aggregate_payload`,
  `checkout_inventory_edges`,
  `checkout_response_payload`
ON `orders`
WHEN
  NEW.`checkout_request_key` IS NOT OLD.`checkout_request_key`
  OR NEW.`checkout_request_hash` IS NOT OLD.`checkout_request_hash`
  OR NEW.`checkout_receipt_hash` IS NOT OLD.`checkout_receipt_hash`
  OR NEW.`checkout_aggregate_version` IS NOT OLD.`checkout_aggregate_version`
  OR NEW.`checkout_aggregate_payload` IS NOT OLD.`checkout_aggregate_payload`
  OR NEW.`checkout_inventory_edges` IS NOT OLD.`checkout_inventory_edges`
  OR NEW.`checkout_response_payload` IS NOT OLD.`checkout_response_payload`
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_AGGREGATE_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_edge_delete_guard`
BEFORE DELETE ON `product_variants`
WHEN EXISTS (
  SELECT 1
  FROM `orders` AS checkout_order
  CROSS JOIN json_each(checkout_order.`checkout_inventory_edges`) AS edge
  WHERE checkout_order.`checkout_aggregate_version` = 1
    AND CAST(json_extract(edge.value, '$.variantId') AS TEXT) = OLD.`id`
  LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_VARIANT_HAS_LEDGER_HISTORY');
END;
--> statement-breakpoint
CREATE TRIGGER `checkout_batch_outbox_shape_guard`
BEFORE INSERT ON `checkout_batch_outbox`
WHEN
  NOT json_valid(NEW.`order_ids`)
  OR json_type(NEW.`order_ids`) <> 'array'
  OR json_array_length(NEW.`order_ids`) NOT BETWEEN 1 AND 280
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_BATCH_OUTBOX_SHAPE_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_lane_capacity_sync`
AFTER UPDATE OF `stock`, `reserved_stock`, `stock_version`
ON `product_variants`
WHEN EXISTS (
  SELECT 1
  FROM `inventory_reservation_lanes`
  WHERE `variant_id` = NEW.`id`
    AND `pool` = 'regular'
)
BEGIN
  UPDATE `inventory_reservation_lanes`
  SET
    `capacity` = `reserved_quantity` + CASE `lane`
      WHEN 0 THEN (
        MAX(
          0,
          NEW.`stock` - NEW.`reserved_stock` - (
            SELECT COALESCE(SUM(`reserved_quantity`), 0)
            FROM `inventory_reservation_lanes`
            WHERE `variant_id` = NEW.`id`
              AND `pool` = 'regular'
              AND `lane` IN (0, 1)
          )
        ) + 1
      ) / 2
      ELSE MAX(
        0,
        NEW.`stock` - NEW.`reserved_stock` - (
          SELECT COALESCE(SUM(`reserved_quantity`), 0)
          FROM `inventory_reservation_lanes`
          WHERE `variant_id` = NEW.`id`
            AND `pool` = 'regular'
            AND `lane` IN (0, 1)
        )
      ) / 2
    END,
    `source_stock_version` = NEW.`stock_version`,
    `updated_at` = unixepoch()
  WHERE `variant_id` = NEW.`id`
    AND `pool` = 'regular'
    AND `lane` IN (0, 1);
END;
