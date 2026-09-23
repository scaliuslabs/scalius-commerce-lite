DO $migration$
BEGIN
  IF EXISTS (SELECT 1 WHERE EXISTS (
  SELECT 1 FROM (
    SELECT "variant_id", "reserved_quantity" AS delta
    FROM "inventory_reservation_lanes"
    WHERE "pool" = 'regular'
    UNION ALL
    SELECT variant_id, -quantity FROM (SELECT
    checkout_order.id AS order_id,
    checkout_order.created_at AS created_at,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'variantId')) AS TEXT) AS variant_id,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'quantity')) AS bigint) AS quantity
  FROM orders AS checkout_order, json_each(checkout_order.checkout_inventory_edges) AS edge
  WHERE checkout_order.inventory_authority = 'checkout_lane_v1'
    AND checkout_order.inventory_action = 'reserved') AS open_edge
  ) AS lane_balance
  GROUP BY "variant_id"
  HAVING SUM(delta) <> 0
)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SINGLE_CHECKOUT_COMMIT_UNRECONCILED';
  END IF;
END
$migration$;
--> statement-breakpoint
-- Orphaned aggregates: a pending projection whose request key already
-- committed a different order (the key was reused with another payload). The
-- buyer never received this order, so it cannot be materialized. Record its
-- lane hold as a voided legacy pair, then cancel it.
INSERT INTO "inventory_movements" (
  "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock",
  "notes", "created_by", "ledger_version", "pool", "reservation_generation", "created_at"
)
SELECT
  'lane-orphan:' || movement.type || ':' || orphan_edge.order_id || ':' || orphan_edge.variant_id,
  orphan_edge.variant_id,
  orphan_edge.order_id,
  movement.type,
  movement.sign * orphan_edge.quantity,
  variant.stock,
  variant.stock,
  'Orphaned checkout-lane hold voided by migration 0065 (its request key belongs to another order)',
  NULL,
  1,
  'regular',
  1,
  unixepoch()
FROM (
  SELECT
    checkout_order.id AS order_id,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'variantId')) AS TEXT) AS variant_id,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'quantity')) AS bigint) AS quantity
  FROM orders AS checkout_order, json_each(checkout_order.checkout_inventory_edges) AS edge
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
    AND EXISTS (
      SELECT 1 FROM "checkout_attempts" AS attempt
      WHERE attempt.request_key = checkout_order.checkout_request_key
        AND attempt.order_id IS NOT NULL
        AND attempt.order_id <> checkout_order.id
    )
    AND checkout_order.inventory_authority = 'checkout_lane_v1'
    AND checkout_order.inventory_action = 'reserved'
) AS orphan_edge
JOIN "product_variants" AS variant ON variant.id = orphan_edge.variant_id
CROSS JOIN (
  SELECT 'reserved' AS type, 1 AS sign
  UNION ALL
  SELECT 'released' AS type, -1 AS sign
) AS movement;
--> statement-breakpoint
UPDATE orders
SET
  status = 'cancelled',
  inventory_action = CASE WHEN inventory_action = 'reserved' THEN 'restored' ELSE inventory_action END,
  checkout_projection_status = 'complete',
  notes = trim(COALESCE(notes, '') || ' Voided by migration 0065: checkout never completed and its request key belongs to another order.'),
  updated_at = unixepoch()
WHERE id IN (
  SELECT checkout_order.id FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
    AND EXISTS (
      SELECT 1 FROM "checkout_attempts" AS attempt
      WHERE attempt.request_key = checkout_order.checkout_request_key
        AND attempt.order_id IS NOT NULL
        AND attempt.order_id <> checkout_order.id
    )
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_variants_checkout_lane_capacity_sync" ON "product_variants";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."product_variants_checkout_lane_capacity_sync_fn"();
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO customers (
      id, name, email, phone, address, city, zone, area,
      city_name, zone_name, area_name,
      total_orders, total_spent, created_at, updated_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'guestCustomerId')),
      checkout_order.customer_name,
      checkout_order.customer_email,
      checkout_order.customer_phone,
      checkout_order.shipping_address,
      checkout_order.city,
      checkout_order.zone,
      checkout_order.area,
      checkout_order.city_name,
      checkout_order.zone_name,
      checkout_order.area_name,
      0, 0, checkout_order.created_at, checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE checkout_order.account_owner_customer_id IS NULL
      AND json_type(
        checkout_order.checkout_aggregate_payload,
        '$.projection.guestCustomerId'
      ) = 'text'
    ORDER BY checkout_order.id
    ON CONFLICT(phone) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    UPDATE orders
    SET customer_id = COALESCE(
      orders.account_owner_customer_id,
      (SELECT customer.id
       FROM customers AS customer
       WHERE customer.phone = orders.customer_phone
       LIMIT 1)
    )
    WHERE orders.id IN (SELECT id FROM target_orders);
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
),
    latest_guest_profile AS MATERIALIZED (
      SELECT
        checkout_order.customer_id,
        MIN(checkout_order.id) AS representative_order_id
      FROM target_orders AS checkout_order
      WHERE checkout_order.account_owner_customer_id IS NULL
        AND checkout_order.customer_id IS NOT NULL
      GROUP BY checkout_order.customer_id
    )
    UPDATE customers
    SET
      name = COALESCE((
        SELECT checkout_order.customer_name
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id
      ), customers.name),
      email = COALESCE((
        SELECT checkout_order.customer_email
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id
      ), customers.email),
      address = COALESCE((
        SELECT checkout_order.shipping_address
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id
      ), customers.address),
      city = COALESCE((
        SELECT checkout_order.city
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id
      ), customers.city),
      zone = COALESCE((
        SELECT checkout_order.zone
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id
      ), customers.zone),
      area = (SELECT checkout_order.area
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id),
      city_name = (SELECT checkout_order.city_name
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id),
      zone_name = (SELECT checkout_order.zone_name
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id),
      area_name = (SELECT checkout_order.area_name
        FROM target_orders AS checkout_order
        JOIN latest_guest_profile AS profile
          ON profile.representative_order_id = checkout_order.id
        WHERE profile.customer_id = customers.id),
      updated_at = unixepoch(),
      deleted_at = NULL
    WHERE customers.account_claimed_at IS NULL
      AND customers.id IN (SELECT customer_id FROM latest_guest_profile);
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
),
    contributions AS MATERIALIZED (
      SELECT
        customer_id,
        COUNT(*) AS order_count,
        SUM(CASE
          WHEN status IN ('cancelled', 'refunded', 'returned', 'partially_refunded')
            OR payment_status IN ('failed', 'refunded')
          THEN 0
          ELSE MAX(0, paid_amount)
        END) AS spent,
        MAX(created_at) AS last_order_at
      FROM target_orders
      WHERE customer_id IS NOT NULL
      GROUP BY customer_id
    )
    UPDATE customers
    SET
      total_orders = customers.total_orders + COALESCE((
        SELECT contribution.order_count
        FROM contributions AS contribution
        WHERE contribution.customer_id = customers.id
      ), 0),
      total_spent = customers.total_spent + COALESCE((
        SELECT contribution.spent
        FROM contributions AS contribution
        WHERE contribution.customer_id = customers.id
      ), 0),
      last_order_at = MAX(COALESCE(customers.last_order_at, 0), COALESCE((
        SELECT contribution.last_order_at
        FROM contributions AS contribution
        WHERE contribution.customer_id = customers.id
      ), 0)),
      updated_at = unixepoch(),
      deleted_at = NULL
    WHERE customers.id IN (SELECT customer_id FROM contributions);
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO customer_history (
      id, customer_id, name, email, phone, address,
      city, zone, area, city_name, zone_name, area_name,
      change_type, created_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'customerHistoryId')),
      checkout_order.customer_id,
      checkout_order.customer_name,
      checkout_order.customer_email,
      checkout_order.customer_phone,
      checkout_order.shipping_address,
      checkout_order.city,
      checkout_order.zone,
      checkout_order.area,
      checkout_order.city_name,
      checkout_order.zone_name,
      checkout_order.area_name,
      CASE WHEN checkout_order.customer_id = scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'guestCustomerId')) THEN 'created' ELSE 'updated' END,
      checkout_order.created_at
    FROM target_orders AS checkout_order
    JOIN customers AS customer ON customer.id = checkout_order.customer_id
    WHERE checkout_order.account_owner_customer_id IS NULL
      AND customer.account_claimed_at IS NULL
      AND json_type(
        checkout_order.checkout_aggregate_payload,
        '$.projection.customerHistoryId'
      ) = 'text'
    ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO checkout_attempts (
      id, request_key, request_hash, checkout_token, order_id,
      status, payment_method, total_amount, response_payload,
      attempts, created_at, updated_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'checkoutAttemptId')),
      checkout_order.checkout_request_key,
      checkout_order.checkout_request_hash,
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'checkoutToken')),
      checkout_order.id,
      'committed',
      checkout_order.payment_method,
      checkout_order.total_amount,
      checkout_order.checkout_response_payload,
      1,
      checkout_order.created_at,
      checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE 1 = 1
    ON CONFLICT(request_key) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO order_receipts (
      token_hash, order_id, source, status, expires_at, created_at, updated_at
    )
    SELECT
      checkout_order.checkout_receipt_hash,
      checkout_order.id,
      'checkout_aggregate',
      'active',
      checkout_order.created_at + 604800,
      checkout_order.created_at,
      checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE 1 = 1
    ON CONFLICT(token_hash) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO order_items (
      id, order_id, product_id, variant_id, product_image_media_id,
      quantity, price, product_name, variant_label, inventory_tracked,
      unit_price_minor, line_subtotal_minor, discount_amount_minor,
      taxable_amount_minor, tax_amount_minor, fulfillment_status, created_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'id')),
      checkout_order.id,
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'productId')),
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'variantId')),
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'productImageMediaId')),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'quantity')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'price')) AS REAL),
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'productName')),
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'variantLabel')),
      COALESCE(CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'inventoryTracked')) AS bigint), 1),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'unitPriceMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'lineSubtotalMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'discountAmountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'taxableAmountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'taxAmountMinor')) AS bigint),
      'pending',
      checkout_order.created_at
    FROM target_orders AS checkout_order
    CROSS JOIN json_each(
      checkout_order.checkout_aggregate_payload,
      '$.payload.items'
    ) AS item
    WHERE 1 = 1
    ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO order_tax_snapshots (
      order_id, currency_code, decimal_places, display_label,
      prices_include_tax, shipping_taxed, subtotal_minor, shipping_minor,
      discount_minor, taxable_minor, tax_minor, total_minor,
      settings_version, calculation_version,
      destination_snapshot, rate_snapshot, created_at
    )
    SELECT
      checkout_order.id,
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'currencyCode')),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'decimalPlaces')) AS bigint),
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'displayLabel')),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'pricesIncludeTax')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'shippingTaxed')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'subtotalMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'shippingMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'discountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'taxableMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'taxMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'totalMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'settingsVersion')) AS bigint),
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'calculationVersion')),
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'destination')),
      (jsonb_build_object('lines', scalius_compat.json_extract_jsonb(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.lines'), 'shipping', scalius_compat.json_extract_jsonb(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.shipping'))::text),
      checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE 1 = 1
    ON CONFLICT(order_id) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO order_item_tax_snapshots (
      order_item_id, order_id, tax_class_id, tax_class_name,
      unit_price_minor, quantity, gross_amount_minor, discount_minor,
      taxable_amount_minor, tax_minor, prices_include_tax,
      rate_snapshot, created_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'id')),
      checkout_order.id,
      scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'taxClassId')),
      scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'taxClassName')),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'unitPriceMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'quantity')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'grossAmountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'discountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'taxableAmountMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'taxMinor')) AS bigint),
      CAST(scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'payload', 'taxQuote', 'pricesIncludeTax')) AS bigint),
      scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'components')),
      checkout_order.created_at
    FROM target_orders AS checkout_order
    CROSS JOIN json_each(
      checkout_order.checkout_aggregate_payload,
      '$.payload.items'
    ) AS item
    JOIN json_each(
      checkout_order.checkout_aggregate_payload,
      '$.payload.taxQuote.lines'
    ) AS tax_line
      ON scalius_compat.json_scalar_text(jsonb_extract_path((tax_line.value)::jsonb, 'lineId'))
       = scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'taxAllocationLineId'))
    WHERE 1 = 1
    ON CONFLICT(order_item_id) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO cod_tracking (
      id, order_id, delivery_attempts, cod_status, created_at, updated_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'codTrackingId')),
      checkout_order.id,
      0,
      'pending',
      checkout_order.created_at,
      checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE checkout_order.payment_method = 'cod'
    ON CONFLICT(order_id) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO order_notification_outbox (
      id, dedupe_key, order_id, notification_type, source, payload,
      status, attempts, next_attempt_at, created_at, updated_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'notificationOutboxId')),
      'order_created:' || checkout_order.id,
      checkout_order.id,
      'order_created',
      'storefront-checkout-aggregate',
      (jsonb_build_object('type', 'order.notification', 'orderId', checkout_order.id, 'customerEmail', checkout_order.customer_email, 'customerName', checkout_order.customer_name, 'notificationType', 'order_created')::text),
      'pending', 0, MAX(0, checkout_order.created_at - 1),
      checkout_order.created_at, checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'notificationOutboxId')) IS NOT NULL
    ON CONFLICT(dedupe_key) DO NOTHING;
--> statement-breakpoint
WITH target_orders AS MATERIALIZED (
  SELECT checkout_order.*
  FROM orders AS checkout_order
  WHERE checkout_order.checkout_aggregate_version = 1
    AND checkout_order.checkout_projection_status <> 'complete'
)
    INSERT INTO meta_capi_purchase_outbox (
      id, order_id, event_id, source, status, attempts,
      next_attempt_at, created_at, updated_at
    )
    SELECT
      scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'metaPurchaseOutboxId')),
      checkout_order.id,
      'Purchase:' || checkout_order.id,
      'storefront-checkout-aggregate',
      'pending', 0, MAX(0, checkout_order.created_at - 1),
      checkout_order.created_at, checkout_order.created_at
    FROM target_orders AS checkout_order
    WHERE checkout_order.payment_method = 'cod'
      AND checkout_order.status NOT IN ('incomplete', 'cancelled', 'refunded', 'returned')
      AND scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'metaPurchaseOutboxId')) IS NOT NULL
    ON CONFLICT(order_id) DO NOTHING;
--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (WITH target_orders AS MATERIALIZED (
    SELECT checkout_order.*
    FROM orders AS checkout_order
    WHERE checkout_order.checkout_aggregate_version = 1
      AND checkout_order.checkout_projection_status <> 'complete'
  )
SELECT 1 WHERE EXISTS (
SELECT 1
FROM target_orders AS checkout_order
WHERE checkout_order.customer_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM checkout_attempts AS attempt
    WHERE attempt.request_key = checkout_order.checkout_request_key
      AND attempt.request_hash = checkout_order.checkout_request_hash
      AND attempt.order_id = checkout_order.id
      AND attempt.status = 'committed'
  )
  OR NOT EXISTS (
    SELECT 1 FROM order_receipts AS receipt
    WHERE receipt.token_hash = checkout_order.checkout_receipt_hash
      AND receipt.order_id = checkout_order.id
      AND receipt.status = 'active'
  )
  OR (SELECT COUNT(*) FROM order_items AS item
      WHERE item.order_id = checkout_order.id)
     <> json_array_length(
       checkout_order.checkout_aggregate_payload,
       '$.payload.items'
     )
  OR (SELECT COUNT(*) FROM order_item_tax_snapshots AS item_tax
      WHERE item_tax.order_id = checkout_order.id)
     <> json_array_length(
       checkout_order.checkout_aggregate_payload,
       '$.payload.items'
     )
  OR NOT EXISTS (
    SELECT 1 FROM order_tax_snapshots AS tax
    WHERE tax.order_id = checkout_order.id
  )
  OR NOT EXISTS (
    SELECT 1 FROM cod_tracking AS cod
    WHERE cod.order_id = checkout_order.id
  )
  OR (
    scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'notificationOutboxId')) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM order_notification_outbox AS notification
      WHERE notification.dedupe_key = 'order_created:' || checkout_order.id
    )
  )
  OR (
    scalius_compat.json_scalar_text(jsonb_extract_path((checkout_order.checkout_aggregate_payload)::jsonb, 'projection', 'metaPurchaseOutboxId')) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM meta_capi_purchase_outbox AS meta
      WHERE meta.order_id = checkout_order.id
    )
  )
)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SINGLE_CHECKOUT_COMMIT_UNRECONCILED';
  END IF;
END
$migration$;
--> statement-breakpoint
WITH edge AS (
  SELECT
    checkout_order.id AS order_id,
    checkout_order.created_at AS created_at,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'variantId')) AS TEXT) AS variant_id,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'quantity')) AS bigint) AS quantity
  FROM orders AS checkout_order, json_each(checkout_order.checkout_inventory_edges) AS edge
  WHERE checkout_order.inventory_authority = 'checkout_lane_v1'
    AND checkout_order.inventory_action = 'reserved'
),
sequenced AS (
  SELECT
    edge.*,
    ROW_NUMBER() OVER (PARTITION BY variant_id ORDER BY order_id) AS edge_position,
    SUM(quantity) OVER (
      PARTITION BY variant_id ORDER BY order_id ROWS UNBOUNDED PRECEDING
    ) AS through_quantity
  FROM edge
)
INSERT INTO "inventory_movements" (
  "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock",
  "notes", "created_by", "ledger_version", "pool", "reservation_generation",
  "stock_version_before", "stock_version_after", "stock_delta",
  "previous_reserved_stock", "new_reserved_stock", "reserved_stock_delta",
  "previous_preorder_stock", "new_preorder_stock", "preorder_stock_delta", "created_at"
)
SELECT
  'lane-fold:' || sequenced.order_id || ':' || sequenced.variant_id,
  sequenced.variant_id,
  sequenced.order_id,
  'reserved',
  sequenced.quantity,
  variant.stock,
  variant.stock,
  'Checkout-lane reservation folded into the SKU counter',
  NULL,
  2,
  'regular',
  1,
  variant.stock_version + sequenced.edge_position - 1,
  variant.stock_version + sequenced.edge_position,
  0,
  variant.reserved_stock + sequenced.through_quantity - sequenced.quantity,
  variant.reserved_stock + sequenced.through_quantity,
  sequenced.quantity,
  variant.preorder_stock,
  variant.preorder_stock,
  0,
  unixepoch()
FROM sequenced
JOIN "product_variants" AS variant ON variant.id = sequenced.variant_id;
--> statement-breakpoint
WITH edge AS (
  SELECT
    checkout_order.id AS order_id,
    checkout_order.created_at AS created_at,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'variantId')) AS TEXT) AS variant_id,
    CAST(scalius_compat.json_scalar_text(jsonb_extract_path((edge.value)::jsonb, 'quantity')) AS bigint) AS quantity
  FROM orders AS checkout_order, json_each(checkout_order.checkout_inventory_edges) AS edge
  WHERE checkout_order.inventory_authority = 'checkout_lane_v1'
    AND checkout_order.inventory_action = 'reserved'
),
held AS (
  SELECT variant_id, SUM(quantity) AS quantity, COUNT(*) AS edges
  FROM edge
  GROUP BY variant_id
)
UPDATE "product_variants"
SET
  "reserved_stock" = "reserved_stock" + (SELECT held.quantity FROM held WHERE held.variant_id = "product_variants"."id"),
  "stock_version" = "stock_version" + (SELECT held.edges FROM held WHERE held.variant_id = "product_variants"."id"),
  "updated_at" = unixepoch()
WHERE "id" IN (SELECT variant_id FROM held);
--> statement-breakpoint
INSERT INTO "inventory_movements" (
  "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock",
  "notes", "created_by", "ledger_version", "pool", "reservation_generation", "created_at"
)
SELECT
  'lane-history:reserved:' || lane_movement.order_id || ':' || lane_movement.variant_id,
  lane_movement.variant_id,
  lane_movement.order_id,
  'reserved',
  lane_movement.quantity,
  lane_movement.stock_before,
  lane_movement.stock_before,
  'Checkout-lane reservation (migrated history)',
  NULL,
  1,
  'regular',
  1,
  COALESCE((SELECT checkout_order.created_at FROM "orders" AS checkout_order WHERE checkout_order.id = lane_movement.order_id), lane_movement.created_at)
FROM "checkout_inventory_lane_movements" AS lane_movement
WHERE 1 = 1;
--> statement-breakpoint
INSERT INTO "inventory_movements" (
  "id", "variant_id", "order_id", "type", "quantity", "previous_stock", "new_stock",
  "notes", "created_by", "ledger_version", "pool", "reservation_generation", "created_at"
)
SELECT
  'lane-history:released:' || lane_movement.id,
  lane_movement.variant_id,
  lane_movement.order_id,
  'released',
  -lane_movement.quantity,
  lane_movement.stock_before,
  lane_movement.stock_after,
  'Checkout-lane reservation released (migrated history)',
  NULL,
  1,
  'regular',
  1,
  lane_movement.created_at
FROM "checkout_inventory_lane_movements" AS lane_movement
WHERE lane_movement.operation = 'released';
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_checkout_aggregate_shape_guard" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."orders_checkout_aggregate_shape_guard_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_checkout_aggregate_immutable_guard" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."orders_checkout_aggregate_immutable_guard_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "product_variants_checkout_edge_delete_guard" ON "product_variants";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."product_variants_checkout_edge_delete_guard_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "checkout_batch_outbox_shape_guard" ON "checkout_batch_outbox";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."checkout_batch_outbox_shape_guard_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_inventory_authority_insert_guard" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."orders_inventory_authority_insert_guard_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_inventory_authority_update_guard" ON "orders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."orders_inventory_authority_update_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."inventory_movements_ledger_v2_insert_semantics_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."ledger_version" = 2 AND NOT (
    (NEW."type" = 'reserved'
        AND NEW."pool" IN ('regular', 'backorder')
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'preorder_reserved'
        AND NEW."pool" = 'preorder'
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND NEW."preorder_stock_delta" = -NEW."quantity")
    OR (NEW."type" = 'released'
        AND NEW."quantity" < 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND (
            (NEW."pool" = 'preorder' AND NEW."preorder_stock_delta" = -NEW."quantity")
            OR (NEW."pool" IN ('regular', 'backorder') AND NEW."preorder_stock_delta" = 0)
        ))
    OR (NEW."type" = 'deducted'
        AND NEW."pool" IN ('regular', 'backorder')
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = CASE WHEN NEW."pool" = 'regular' THEN -NEW."quantity" ELSE 0 END
        AND NEW."reserved_stock_delta" = -NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'preorder_deducted'
        AND NEW."pool" = 'preorder'
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = -NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'restored'
        AND NEW."quantity" > 0
        AND NEW."reserved_stock_delta" = 0
        AND NEW."stock_delta" = CASE WHEN NEW."pool" = 'regular' THEN NEW."quantity" ELSE 0 END
        AND NEW."preorder_stock_delta" = CASE WHEN NEW."pool" = 'preorder' THEN NEW."quantity" ELSE 0 END)
    OR (NEW."type" = 'adjusted'
        AND NEW."reserved_stock_delta" = 0
        AND (
            (NEW."pool" = 'regular' AND NEW."stock_delta" = NEW."quantity" AND NEW."preorder_stock_delta" = 0)
            OR (NEW."pool" = 'preorder' AND NEW."stock_delta" = 0 AND NEW."preorder_stock_delta" = NEW."quantity")
        ))
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid inventory ledger v2 operation semantics';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."inventory_movements_ledger_v2_update_semantics_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."ledger_version" = 2 AND NOT (
    (NEW."type" = 'reserved'
        AND NEW."pool" IN ('regular', 'backorder')
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'preorder_reserved'
        AND NEW."pool" = 'preorder'
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND NEW."preorder_stock_delta" = -NEW."quantity")
    OR (NEW."type" = 'released'
        AND NEW."quantity" < 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = NEW."quantity"
        AND (
            (NEW."pool" = 'preorder' AND NEW."preorder_stock_delta" = -NEW."quantity")
            OR (NEW."pool" IN ('regular', 'backorder') AND NEW."preorder_stock_delta" = 0)
        ))
    OR (NEW."type" = 'deducted'
        AND NEW."pool" IN ('regular', 'backorder')
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = CASE WHEN NEW."pool" = 'regular' THEN -NEW."quantity" ELSE 0 END
        AND NEW."reserved_stock_delta" = -NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'preorder_deducted'
        AND NEW."pool" = 'preorder'
        AND NEW."quantity" > 0
        AND NEW."stock_delta" = 0
        AND NEW."reserved_stock_delta" = -NEW."quantity"
        AND NEW."preorder_stock_delta" = 0)
    OR (NEW."type" = 'restored'
        AND NEW."quantity" > 0
        AND NEW."reserved_stock_delta" = 0
        AND NEW."stock_delta" = CASE WHEN NEW."pool" = 'regular' THEN NEW."quantity" ELSE 0 END
        AND NEW."preorder_stock_delta" = CASE WHEN NEW."pool" = 'preorder' THEN NEW."quantity" ELSE 0 END)
    OR (NEW."type" = 'adjusted'
        AND NEW."reserved_stock_delta" = 0
        AND (
            (NEW."pool" = 'regular' AND NEW."stock_delta" = NEW."quantity" AND NEW."preorder_stock_delta" = 0)
            OR (NEW."pool" = 'preorder' AND NEW."stock_delta" = 0 AND NEW."preorder_stock_delta" = NEW."quantity")
        ))
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid inventory ledger v2 operation semantics';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP INDEX IF EXISTS "orders_checkout_request_key_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "orders_checkout_receipt_hash_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "orders_checkout_projection_idx";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_request_key";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_request_hash";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_receipt_hash";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_aggregate_version";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_aggregate_payload";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_inventory_edges";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_response_payload";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_projection_status";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "checkout_projection_attempts";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "inventory_authority";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat.checkout_commit_v1(jsonb, bigint, jsonb, text, text);
--> statement-breakpoint
DROP TABLE IF EXISTS "checkout_batch_outbox";
--> statement-breakpoint
DROP TABLE IF EXISTS "checkout_inventory_lane_movements";
--> statement-breakpoint
DROP TABLE IF EXISTS "inventory_reservation_lanes";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (65, '0065_single_checkout_commit', 'b00f8d765b7c4851d6547678a02cd94be2c0ae6d7e42df46de845361df4d08fb');
