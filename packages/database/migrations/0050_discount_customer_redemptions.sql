-- Immutable one-per-customer discount redemption claims.
-- The checkout phone on an order may be corrected later by admins, so the
-- per-customer coupon guard must claim the original checkout identity at the
-- moment discount_usage is inserted.

CREATE TABLE IF NOT EXISTS `discount_customer_redemptions` (
    `discount_id` text NOT NULL,
    `customer_key` text NOT NULL,
    `order_id` text NOT NULL,
    `customer_id` text,
    `created_at` integer DEFAULT (unixepoch()) NOT NULL,
    PRIMARY KEY (`discount_id`, `customer_key`),
    FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON DELETE cascade,
    FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade,
    FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discount_customer_redemptions_order_id_idx`
ON `discount_customer_redemptions` (`order_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discount_customer_redemptions_customer_id_idx`
ON `discount_customer_redemptions` (`customer_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `discount_customer_redemptions` (
    `discount_id`,
    `customer_key`,
    `order_id`,
    `customer_id`,
    `created_at`
)
SELECT
    du.`discount_id`,
    'phone:' || TRIM(o.`customer_phone`),
    du.`order_id`,
    du.`customer_id`,
    COALESCE(du.`created_at`, unixepoch())
FROM `discount_usage` AS du
JOIN `orders` AS o
    ON o.`id` = du.`order_id`
JOIN `discounts` AS d
    ON d.`id` = du.`discount_id`
WHERE d.`limit_one_per_customer` = 1
  AND NULLIF(TRIM(o.`customer_phone`), '') IS NOT NULL
ORDER BY du.`created_at`, du.`id`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `discount_usage_one_per_customer_guard`;
--> statement-breakpoint
CREATE TRIGGER `discount_usage_one_per_customer_guard`
BEFORE INSERT ON `discount_usage`
WHEN (
    SELECT `limit_one_per_customer`
    FROM `discounts`
    WHERE `id` = NEW.`discount_id`
) = 1
BEGIN
    SELECT RAISE(ABORT, 'DISCOUNT_CUSTOMER_KEY_REQUIRED')
    WHERE NOT EXISTS (
        SELECT 1
        FROM `orders` AS new_order
        WHERE new_order.`id` = NEW.`order_id`
          AND NULLIF(TRIM(new_order.`customer_phone`), '') IS NOT NULL
    );

    SELECT RAISE(ABORT, 'DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED')
    WHERE EXISTS (
        SELECT 1
        FROM `discount_customer_redemptions` AS redemption
        JOIN `orders` AS new_order
            ON new_order.`id` = NEW.`order_id`
        WHERE redemption.`discount_id` = NEW.`discount_id`
          AND redemption.`customer_key` = 'phone:' || TRIM(new_order.`customer_phone`)
        LIMIT 1
    );

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
    WHERE new_order.`id` = NEW.`order_id`;
END;
