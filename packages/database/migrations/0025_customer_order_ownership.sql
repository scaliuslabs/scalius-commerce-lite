ALTER TABLE `orders` ADD `account_owner_customer_id` text REFERENCES customers(id) ON DELETE SET NULL;--> statement-breakpoint
UPDATE `orders`
SET `account_owner_customer_id` = `customer_id`
WHERE `customer_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `customers` (
  `id`,
  `name`,
  `email`,
  `phone`,
  `address`,
  `city`,
  `zone`,
  `area`,
  `city_name`,
  `zone_name`,
  `area_name`,
  `total_orders`,
  `total_spent`,
  `last_order_at`,
  `created_at`,
  `updated_at`
)
SELECT
  'cust_guest_' || `latest_order_id`,
  `customer_name`,
  `customer_email`,
  `normalized_phone`,
  `shipping_address`,
  `city`,
  `zone`,
  `area`,
  `city_name`,
  `zone_name`,
  `area_name`,
  0,
  0,
  NULL,
  `first_order_at`,
  `latest_order_at`
FROM (
  SELECT
    `id` AS `latest_order_id`,
    `customer_name`,
    `customer_email`,
    trim(`customer_phone`) AS `normalized_phone`,
    `shipping_address`,
    `city`,
    `zone`,
    `area`,
    `city_name`,
    `zone_name`,
    `area_name`,
    min(CAST(`created_at` AS INTEGER)) OVER (
      PARTITION BY trim(`customer_phone`)
    ) AS `first_order_at`,
    max(CAST(`created_at` AS INTEGER)) OVER (
      PARTITION BY trim(`customer_phone`)
    ) AS `latest_order_at`,
    row_number() OVER (
      PARTITION BY trim(`customer_phone`)
      ORDER BY CAST(`created_at` AS INTEGER) DESC, `id` DESC
    ) AS `phone_row_number`
  FROM `orders`
  WHERE `customer_id` IS NULL
    AND trim(`customer_phone`) <> ''
)
WHERE `phone_row_number` = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `customer_history` (
  `id`,
  `customer_id`,
  `name`,
  `email`,
  `phone`,
  `address`,
  `city`,
  `zone`,
  `area`,
  `city_name`,
  `zone_name`,
  `area_name`,
  `change_type`,
  `created_at`
)
SELECT
  'hist_migration_' || `customers`.`id`,
  `customers`.`id`,
  `customers`.`name`,
  `customers`.`email`,
  `customers`.`phone`,
  `customers`.`address`,
  `customers`.`city`,
  `customers`.`zone`,
  `customers`.`area`,
  `customers`.`city_name`,
  `customers`.`zone_name`,
  `customers`.`area_name`,
  'created',
  `customers`.`created_at`
FROM `customers`
WHERE `customers`.`id` LIKE 'cust_guest_%'
  AND NOT EXISTS (
    SELECT 1
    FROM `customer_history`
    WHERE `customer_history`.`customer_id` = `customers`.`id`
  );--> statement-breakpoint
UPDATE `orders`
SET `customer_id` = (
  SELECT `customers`.`id`
  FROM `customers`
  WHERE `customers`.`phone` = trim(`orders`.`customer_phone`)
  LIMIT 1
)
WHERE `customer_id` IS NULL
  AND trim(`customer_phone`) <> ''
  AND EXISTS (
    SELECT 1
    FROM `customers`
    WHERE `customers`.`phone` = trim(`orders`.`customer_phone`)
  );--> statement-breakpoint
UPDATE `customers`
SET
  `total_orders` = COALESCE((
    SELECT count(*)
    FROM `orders`
    WHERE `orders`.`customer_id` = `customers`.`id`
      AND `orders`.`deleted_at` IS NULL
  ), 0),
  `total_spent` = COALESCE((
    SELECT sum(
      max(COALESCE(`orders`.`paid_amount`, 0), 0)
    )
    FROM `orders`
    WHERE `orders`.`customer_id` = `customers`.`id`
      AND `orders`.`deleted_at` IS NULL
  ), 0),
  `last_order_at` = (
    SELECT max(CAST(`orders`.`created_at` AS INTEGER))
    FROM `orders`
    WHERE `orders`.`customer_id` = `customers`.`id`
      AND `orders`.`deleted_at` IS NULL
  );--> statement-breakpoint
CREATE INDEX `orders_account_owner_customer_id_idx` ON `orders` (`account_owner_customer_id`);
