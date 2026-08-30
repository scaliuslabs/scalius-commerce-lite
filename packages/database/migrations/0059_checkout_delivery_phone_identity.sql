DROP TRIGGER IF EXISTS `discount_usage_one_per_customer_guard`;
--> statement-breakpoint
INSERT OR IGNORE INTO `discount_customer_redemptions` (
  `discount_id`,
  `customer_key`,
  `order_id`,
  `customer_id`,
  `created_at`
)
SELECT
  redemption.`discount_id`,
  'customer:' || order_record.`account_owner_customer_id`,
  redemption.`order_id`,
  order_record.`account_owner_customer_id`,
  redemption.`created_at`
FROM `discount_customer_redemptions` AS redemption
INNER JOIN `orders` AS order_record
  ON order_record.`id` = redemption.`order_id`
WHERE order_record.`account_owner_customer_id` IS NOT NULL
ORDER BY redemption.`created_at` ASC, redemption.`order_id` ASC;
--> statement-breakpoint
CREATE TRIGGER `discount_usage_customer_identity_guard`
BEFORE INSERT ON `discount_usage`
WHEN (
  SELECT `limit_one_per_customer`
  FROM `discounts`
  WHERE `id` = NEW.`discount_id`
) = 1
AND NOT EXISTS (
  SELECT 1
  FROM `orders` AS new_order
  WHERE new_order.`id` = NEW.`order_id`
    AND NULLIF(TRIM(new_order.`customer_phone`), '') IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'DISCOUNT_CUSTOMER_KEY_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `discount_usage_one_per_customer_guard`
BEFORE INSERT ON `discount_usage`
WHEN (
  SELECT `limit_one_per_customer`
  FROM `discounts`
  WHERE `id` = NEW.`discount_id`
) = 1
AND EXISTS (
  SELECT 1
  FROM `discount_customer_redemptions` AS redemption
  INNER JOIN `orders` AS new_order
    ON new_order.`id` = NEW.`order_id`
  WHERE redemption.`discount_id` = NEW.`discount_id`
    AND (
      redemption.`customer_key` = 'phone:' || TRIM(new_order.`customer_phone`)
      OR (
        new_order.`account_owner_customer_id` IS NOT NULL
        AND redemption.`customer_key` = 'customer:' || new_order.`account_owner_customer_id`
      )
    )
  LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT, 'DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED');
END;
--> statement-breakpoint
CREATE TRIGGER `discount_usage_customer_redemption_claim`
AFTER INSERT ON `discount_usage`
WHEN (
  SELECT `limit_one_per_customer`
  FROM `discounts`
  WHERE `id` = NEW.`discount_id`
) = 1
BEGIN
  INSERT INTO `discount_customer_redemptions` (
    `discount_id`,
    `customer_key`,
    `order_id`,
    `customer_id`,
    `created_at`
  )
  SELECT
    NEW.`discount_id`,
    'phone:' || TRIM(new_order.`customer_phone`),
    NEW.`order_id`,
    NEW.`customer_id`,
    COALESCE(NEW.`created_at`, unixepoch())
  FROM `orders` AS new_order
  WHERE new_order.`id` = NEW.`order_id`
  UNION ALL
  SELECT
    NEW.`discount_id`,
    'customer:' || new_order.`account_owner_customer_id`,
    NEW.`order_id`,
    new_order.`account_owner_customer_id`,
    COALESCE(NEW.`created_at`, unixepoch())
  FROM `orders` AS new_order
  WHERE new_order.`id` = NEW.`order_id`
    AND new_order.`account_owner_customer_id` IS NOT NULL;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (59, '0059_checkout_delivery_phone_identity', 'a5759548b627414ea6cf4e687413fa07895ed225b748305f13be18d810b0a9fd');
