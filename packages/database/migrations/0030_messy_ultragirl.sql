ALTER TABLE `promotions` ADD `max_redemptions` integer;--> statement-breakpoint
ALTER TABLE `promotions` ADD `max_redemptions_per_customer` integer;--> statement-breakpoint
ALTER TABLE `promotions` ADD `max_discount_spend_minor` integer;--> statement-breakpoint
ALTER TABLE `promotions` ADD `budget_currency_code` text;--> statement-breakpoint
CREATE TRIGGER promotions_budget_shape_insert_guard
BEFORE INSERT ON promotions
WHEN (NEW.max_redemptions IS NOT NULL AND NEW.max_redemptions < 1)
	OR (NEW.max_redemptions_per_customer IS NOT NULL AND NEW.max_redemptions_per_customer < 1)
	OR (NEW.max_redemptions IS NOT NULL
		AND NEW.max_redemptions_per_customer IS NOT NULL
		AND NEW.max_redemptions_per_customer > NEW.max_redemptions)
	OR NOT (
		(NEW.max_discount_spend_minor IS NULL AND NEW.budget_currency_code IS NULL)
		OR (NEW.max_discount_spend_minor >= 1
			AND length(NEW.budget_currency_code) = 3
			AND NEW.budget_currency_code = upper(NEW.budget_currency_code)
			AND NEW.budget_currency_code NOT GLOB '*[^A-Z]*')
	)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_BUDGET_SHAPE_INVALID');
END;--> statement-breakpoint
CREATE TRIGGER promotions_budget_shape_update_guard
BEFORE UPDATE OF max_redemptions, max_redemptions_per_customer, max_discount_spend_minor, budget_currency_code ON promotions
WHEN (NEW.max_redemptions IS NOT NULL AND NEW.max_redemptions < 1)
	OR (NEW.max_redemptions_per_customer IS NOT NULL AND NEW.max_redemptions_per_customer < 1)
	OR (NEW.max_redemptions IS NOT NULL
		AND NEW.max_redemptions_per_customer IS NOT NULL
		AND NEW.max_redemptions_per_customer > NEW.max_redemptions)
	OR NOT (
		(NEW.max_discount_spend_minor IS NULL AND NEW.budget_currency_code IS NULL)
		OR (NEW.max_discount_spend_minor >= 1
			AND length(NEW.budget_currency_code) = 3
			AND NEW.budget_currency_code = upper(NEW.budget_currency_code)
			AND NEW.budget_currency_code NOT GLOB '*[^A-Z]*')
	)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_BUDGET_SHAPE_INVALID');
END;--> statement-breakpoint
CREATE TABLE `promotion_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`promotion_revision` integer NOT NULL,
	`promotion_code` text NOT NULL,
	`currency_code` text NOT NULL,
	`discount_amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "promotion_redemptions_revision_positive" CHECK(`promotion_revision` >= 1),
	CONSTRAINT "promotion_redemptions_code_shape" CHECK(length(`promotion_code`) BETWEEN 3 AND 50
            AND `promotion_code` = upper(trim(`promotion_code`))
            AND `promotion_code` NOT GLOB '*[^A-Z0-9_-]*'),
	CONSTRAINT "promotion_redemptions_currency_shape" CHECK(length(`currency_code`) = 3
            AND `currency_code` = upper(`currency_code`)
            AND `currency_code` NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "promotion_redemptions_discount_positive" CHECK(`discount_amount_minor` > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_redemptions_order_unique` ON `promotion_redemptions` (`order_id`);--> statement-breakpoint
CREATE INDEX `promotion_redemptions_promotion_idx` ON `promotion_redemptions` (`promotion_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `promotion_redemptions_customer_idx` ON `promotion_redemptions` (`promotion_id`,`customer_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_reference_guard
BEFORE INSERT ON promotion_redemptions
WHEN NOT EXISTS (
	SELECT 1
	FROM promotions AS promotion
	JOIN promotion_codes AS code
		ON code.promotion_id = promotion.id
	WHERE promotion.id = NEW.promotion_id
		AND promotion.method = 'code'
		AND promotion.status = 'active'
		AND promotion.deleted_at IS NULL
		AND promotion.revision = NEW.promotion_revision
		AND (promotion.starts_at IS NULL OR promotion.starts_at <= unixepoch())
		AND (promotion.ends_at IS NULL OR promotion.ends_at > unixepoch())
		AND code.normalized_code = NEW.promotion_code
		AND code.is_active = 1
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_NOT_ELIGIBLE');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_total_limit_guard
BEFORE INSERT ON promotion_redemptions
WHEN (
	SELECT max_redemptions FROM promotions WHERE id = NEW.promotion_id
) IS NOT NULL
AND (
	SELECT count(*) FROM promotion_redemptions WHERE promotion_id = NEW.promotion_id
) >= (
	SELECT max_redemptions FROM promotions WHERE id = NEW.promotion_id
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_TOTAL_LIMIT');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_customer_limit_guard
BEFORE INSERT ON promotion_redemptions
WHEN (
	SELECT max_redemptions_per_customer FROM promotions WHERE id = NEW.promotion_id
) IS NOT NULL
AND (
	SELECT count(*) FROM promotion_redemptions
	WHERE promotion_id = NEW.promotion_id AND customer_id = NEW.customer_id
) >= (
	SELECT max_redemptions_per_customer FROM promotions WHERE id = NEW.promotion_id
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_CUSTOMER_LIMIT');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_spend_limit_guard
BEFORE INSERT ON promotion_redemptions
WHEN (
	SELECT max_discount_spend_minor FROM promotions WHERE id = NEW.promotion_id
) IS NOT NULL
AND (
	NEW.currency_code <> (
		SELECT budget_currency_code FROM promotions WHERE id = NEW.promotion_id
	)
	OR coalesce((
		SELECT sum(discount_amount_minor) FROM promotion_redemptions
		WHERE promotion_id = NEW.promotion_id
	), 0) + NEW.discount_amount_minor > (
		SELECT max_discount_spend_minor FROM promotions WHERE id = NEW.promotion_id
	)
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_SPEND_LIMIT');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_allocation_guard
BEFORE INSERT ON promotion_redemptions
WHEN NOT EXISTS (
	SELECT 1 FROM order_discount_allocations
	WHERE order_id = NEW.order_id
)
OR EXISTS (
	SELECT 1 FROM order_discount_allocations
	WHERE order_id = NEW.order_id
		AND (
			promotion_id <> NEW.promotion_id
			OR promotion_revision <> NEW.promotion_revision
			OR method <> 'code'
			OR promotion_code <> NEW.promotion_code
			OR currency_code <> NEW.currency_code
		)
)
OR (
	SELECT coalesce(sum(discount_amount_minor), 0)
	FROM order_discount_allocations
	WHERE order_id = NEW.order_id
) <> NEW.discount_amount_minor
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_ALLOCATION_MISMATCH');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_immutable_update
BEFORE UPDATE ON promotion_redemptions
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER promotion_redemptions_immutable_delete
BEFORE DELETE ON promotion_redemptions
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_REDEMPTION_IMMUTABLE');
END;
