-- Only a code-verified phone/email identifies an account. A typed phone is a
-- claim: it no longer has to be unique, so it can never block or take over
-- anyone. One account per verified phone, one per verified email, and one
-- guest record per phone for the merchant's customer list.
UPDATE `orders`
SET `customer_id` = `account_owner_customer_id`
WHERE `account_owner_customer_id` IS NOT NULL
  AND (`customer_id` IS NULL OR `customer_id` <> `account_owner_customer_id`);
--> statement-breakpoint
UPDATE `customers`
SET `email_verified_at` = NULL
WHERE `email_verified_at` IS NOT NULL
  AND `deleted_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `customers` AS `earlier`
    WHERE `earlier`.`email_verified_at` IS NOT NULL
      AND `earlier`.`deleted_at` IS NULL
      AND lower(`earlier`.`email`) = lower(`customers`.`email`)
      AND (`earlier`.`email_verified_at` < `customers`.`email_verified_at`
        OR (`earlier`.`email_verified_at` = `customers`.`email_verified_at` AND `earlier`.`id` < `customers`.`id`))
  );
--> statement-breakpoint
DROP INDEX IF EXISTS `customer_phone_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_verified_phone_unique` ON `customers` (`phone`) WHERE `phone_verified_at` IS NOT NULL AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_verified_email_unique` ON `customers` (lower(`email`)) WHERE `email_verified_at` IS NOT NULL AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_guest_phone_unique` ON `customers` (`phone`) WHERE `account_claimed_at` IS NULL AND `deleted_at` IS NULL;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (74, '0074_verified_customer_identity', 'e678a6ac0d06ccaa55b95159fd8fd4564e262356c4694254d3cd4729004b36d6');
