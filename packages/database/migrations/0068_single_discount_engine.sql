-- One discount engine: promotions (code + automatic, product/collection scope
-- in effect/condition config) replace the legacy discount-code tables. Legacy
-- discount rows are not carried over (owner rule: demo data is disposable).
ALTER TABLE `promotions` ADD `combines_with_product_discounts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `promotions` ADD `combines_with_order_discounts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `promotions` ADD `combines_with_shipping_discounts` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- A discount now has exactly one value (one class). Retire older multi-value rules.
UPDATE `promotions` SET `status` = 'archived', `deleted_at` = unixepoch(), `updated_at` = unixepoch()
WHERE `deleted_at` IS NULL AND `id` IN (
	SELECT `promotion_id` FROM `promotion_effects` WHERE `deleted_at` IS NULL
	GROUP BY `promotion_id` HAVING count(*) > 1
);--> statement-breakpoint
-- Combined discounts share an order: a code claim reconciles only its own allocations.
DROP TRIGGER `promotion_redemptions_allocation_guard`;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_allocation_guard
BEFORE INSERT ON promotion_redemptions
WHEN NOT EXISTS (
	SELECT 1 FROM order_discount_allocations
	WHERE order_id = NEW.order_id AND promotion_id = NEW.promotion_id
)
OR EXISTS (
	SELECT 1 FROM order_discount_allocations
	WHERE order_id = NEW.order_id
		AND promotion_id = NEW.promotion_id
		AND (
			promotion_revision <> NEW.promotion_revision
			OR method <> 'code'
			OR promotion_code <> NEW.promotion_code
			OR currency_code <> NEW.currency_code
		)
)
OR (
	SELECT coalesce(sum(discount_amount_minor), 0)
	FROM order_discount_allocations
	WHERE order_id = NEW.order_id AND promotion_id = NEW.promotion_id
) <> NEW.discount_amount_minor
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_ALLOCATION_MISMATCH');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `promotion_codes_legacy_identity_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `promotion_codes_legacy_identity_update_guard`;--> statement-breakpoint
DROP TABLE IF EXISTS `discounts_fts`;--> statement-breakpoint
DROP TABLE `discount_customer_redemptions`;--> statement-breakpoint
DROP TABLE `discount_usage`;--> statement-breakpoint
DROP TABLE `discount_collections`;--> statement-breakpoint
DROP TABLE `discount_products`;--> statement-breakpoint
DROP TABLE `discounts`;--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (68, '0068_single_discount_engine', '9c33e0354f8b670c98596fbfa9daa760198a6fed7287c309293a4661ff5d8ce3');
