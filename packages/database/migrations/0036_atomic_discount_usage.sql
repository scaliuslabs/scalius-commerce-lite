-- Atomic discount redemption guards.
-- Validation endpoints remain advisory; these triggers are the source of truth
-- when checkout writes discount_usage.

CREATE TRIGGER IF NOT EXISTS discount_usage_max_uses_guard
BEFORE INSERT ON discount_usage
WHEN (
    SELECT max_uses
    FROM discounts
    WHERE id = NEW.discount_id
) IS NOT NULL
AND (
    SELECT COUNT(*)
    FROM discount_usage
    WHERE discount_id = NEW.discount_id
) >= (
    SELECT max_uses
    FROM discounts
    WHERE id = NEW.discount_id
)
BEGIN
    SELECT RAISE(ABORT, 'DISCOUNT_MAX_USES_EXCEEDED');
END;

CREATE TRIGGER IF NOT EXISTS discount_usage_one_per_customer_guard
BEFORE INSERT ON discount_usage
WHEN (
    SELECT limit_one_per_customer
    FROM discounts
    WHERE id = NEW.discount_id
) = 1
AND EXISTS (
    SELECT 1
    FROM discount_usage AS existing_usage
    JOIN orders AS existing_order
        ON existing_order.id = existing_usage.order_id
    JOIN orders AS new_order
        ON new_order.id = NEW.order_id
    WHERE existing_usage.discount_id = NEW.discount_id
      AND existing_order.customer_phone = new_order.customer_phone
    LIMIT 1
)
BEGIN
    SELECT RAISE(ABORT, 'DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED');
END;
