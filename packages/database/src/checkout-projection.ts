import {
  CHECKOUT_COMMIT_HARD_MAX_ORDERS,
  type PortableSqlStatement,
} from "./checkout-commit";
import type { CheckoutSqlTransport } from "./checkout-transport";

const ORDER_RECEIPT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
export const CHECKOUT_PROJECTION_MAX_OUTBOXES = 25;
export const CHECKOUT_PROJECTION_MAX_ORDERS = 500;

const TARGET_ORDERS_CTE = `target_outboxes AS MATERIALIZED (
    SELECT batch_outbox.*
    FROM json_each(?1) AS requested_outbox
    JOIN checkout_batch_outbox AS batch_outbox
      ON batch_outbox.id = CAST(requested_outbox.value AS TEXT)
    WHERE batch_outbox.status IN ('pending', 'failed')
  ),
  target_orders AS MATERIALIZED (
    SELECT checkout_order.*
    FROM target_outboxes AS batch_outbox
    CROSS JOIN json_each(batch_outbox.order_ids) AS target_id
    JOIN orders AS checkout_order
      ON checkout_order.id = CAST(target_id.value AS TEXT)
    WHERE checkout_order.checkout_aggregate_version = 1
      AND checkout_order.checkout_projection_status <> 'complete'
  )`;

/**
 * Deterministically materialize normalized compatibility/read models from one
 * authoritative checkout aggregate batch. Every statement is idempotent and
 * the caller executes the returned list in one atomic transaction.
 */
export function buildCheckoutProjectionStatements(
  outboxId: string,
): PortableSqlStatement[] {
  return buildCheckoutProjectionBatchStatements([outboxId]);
}

/**
 * Materialize several committed aggregate batches with one fixed statement
 * set. Grouping outboxes removes repeated projection transactions without
 * changing the independently recoverable order/outbox authority.
 */
export function buildCheckoutProjectionBatchStatements(
  outboxIds: readonly string[],
): PortableSqlStatement[] {
  if (
    outboxIds.length < 1
    || outboxIds.length > CHECKOUT_PROJECTION_MAX_OUTBOXES
    || new Set(outboxIds).size !== outboxIds.length
    || outboxIds.some((outboxId) =>
      typeof outboxId !== "string" || !outboxId.trim() || outboxId.length > 180
    )
  ) {
    throw new Error("Checkout projection outbox ids are invalid or outside the batch limit.");
  }
  const args = [JSON.stringify(outboxIds)] as const;

  return [{
    sql: `SELECT CASE WHEN json_array_length(?1)
        BETWEEN 1 AND ${CHECKOUT_PROJECTION_MAX_OUTBOXES}
      AND (SELECT COUNT(DISTINCT CAST(value AS TEXT)) FROM json_each(?1))
        = json_array_length(?1)
      AND COALESCE((
        SELECT SUM(json_array_length(batch_outbox.order_ids))
        FROM json_each(?1) AS requested_outbox
        JOIN checkout_batch_outbox AS batch_outbox
          ON batch_outbox.id = CAST(requested_outbox.value AS TEXT)
        WHERE json_valid(batch_outbox.order_ids)
      ), 0) <= ${CHECKOUT_PROJECTION_MAX_ORDERS}
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?1) AS requested_outbox
        LEFT JOIN checkout_batch_outbox AS batch_outbox
          ON batch_outbox.id = CAST(requested_outbox.value AS TEXT)
        WHERE batch_outbox.id IS NULL
          OR (
            batch_outbox.status <> 'complete'
            AND (
              batch_outbox.status NOT IN ('pending', 'failed')
              OR NOT json_valid(batch_outbox.order_ids)
              OR NOT EXISTS (SELECT 1 FROM json_each(batch_outbox.order_ids))
              OR EXISTS (
                SELECT 1
                FROM json_each(batch_outbox.order_ids) AS target_id
                LEFT JOIN orders AS checkout_order
                  ON checkout_order.id = CAST(target_id.value AS TEXT)
                 AND checkout_order.checkout_aggregate_version = 1
                WHERE checkout_order.id IS NULL
              )
            )
          )
      )
      THEN 1
      ELSE json_extract('{}', 'CHECKOUT_PROJECTION_AUTHORITY_INVALID')
      END`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO customers (
        id, name, email, phone, address, city, zone, area,
        city_name, zone_name, area_name,
        total_orders, total_spent, created_at, updated_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.guestCustomerId'),
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
      ON CONFLICT(phone) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      UPDATE orders
      SET customer_id = COALESCE(
        orders.account_owner_customer_id,
        (SELECT customer.id
         FROM customers AS customer
         WHERE customer.phone = orders.customer_phone
         LIMIT 1)
      )
      WHERE orders.id IN (SELECT id FROM target_orders)`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE},
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
        AND customers.id IN (SELECT customer_id FROM latest_guest_profile)`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE},
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
      WHERE customers.id IN (SELECT customer_id FROM contributions)`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO customer_history (
        id, customer_id, name, email, phone, address,
        city, zone, area, city_name, zone_name, area_name,
        change_type, created_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.customerHistoryId'),
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
        CASE WHEN checkout_order.customer_id = json_extract(
          checkout_order.checkout_aggregate_payload,
          '$.projection.guestCustomerId'
        ) THEN 'created' ELSE 'updated' END,
        checkout_order.created_at
      FROM target_orders AS checkout_order
      JOIN customers AS customer ON customer.id = checkout_order.customer_id
      WHERE checkout_order.account_owner_customer_id IS NULL
        AND customer.account_claimed_at IS NULL
        AND json_type(
          checkout_order.checkout_aggregate_payload,
          '$.projection.customerHistoryId'
        ) = 'text'
      ON CONFLICT(id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO checkout_attempts (
        id, request_key, request_hash, checkout_token, order_id,
        status, payment_method, total_amount, response_payload,
        attempts, created_at, updated_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.checkoutAttemptId'),
        checkout_order.checkout_request_key,
        checkout_order.checkout_request_hash,
        json_extract(checkout_order.checkout_aggregate_payload, '$.payload.checkoutToken'),
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
      ON CONFLICT(request_key) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO order_receipts (
        token_hash, order_id, source, status, expires_at, created_at, updated_at
      )
      SELECT
        checkout_order.checkout_receipt_hash,
        checkout_order.id,
        'checkout_aggregate',
        'active',
        checkout_order.created_at + ${ORDER_RECEIPT_TOKEN_TTL_SECONDS},
        checkout_order.created_at,
        checkout_order.created_at
      FROM target_orders AS checkout_order
      WHERE 1 = 1
      ON CONFLICT(token_hash) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO order_items (
        id, order_id, product_id, variant_id, product_image_media_id,
        quantity, price, product_name, variant_label, inventory_tracked,
        unit_price_minor, line_subtotal_minor, discount_amount_minor,
        taxable_amount_minor, tax_amount_minor, fulfillment_status, created_at
      )
      SELECT
        json_extract(item.value, '$.id'),
        checkout_order.id,
        json_extract(item.value, '$.productId'),
        json_extract(item.value, '$.variantId'),
        json_extract(item.value, '$.productImageMediaId'),
        CAST(json_extract(item.value, '$.quantity') AS INTEGER),
        CAST(json_extract(item.value, '$.price') AS REAL),
        json_extract(item.value, '$.productName'),
        json_extract(item.value, '$.variantLabel'),
        COALESCE(CAST(json_extract(item.value, '$.inventoryTracked') AS INTEGER), 1),
        CAST(json_extract(item.value, '$.unitPriceMinor') AS INTEGER),
        CAST(json_extract(item.value, '$.lineSubtotalMinor') AS INTEGER),
        CAST(json_extract(item.value, '$.discountAmountMinor') AS INTEGER),
        CAST(json_extract(item.value, '$.taxableAmountMinor') AS INTEGER),
        CAST(json_extract(item.value, '$.taxAmountMinor') AS INTEGER),
        'pending',
        checkout_order.created_at
      FROM target_orders AS checkout_order
      CROSS JOIN json_each(
        checkout_order.checkout_aggregate_payload,
        '$.payload.items' /* scalius:postgres-jsonb */
      ) AS item
      WHERE 1 = 1
      ON CONFLICT(id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO order_tax_snapshots (
        order_id, currency_code, decimal_places, display_label,
        prices_include_tax, shipping_taxed, subtotal_minor, shipping_minor,
        discount_minor, taxable_minor, tax_minor, total_minor,
        settings_version, calculation_version,
        destination_snapshot, rate_snapshot, created_at
      )
      SELECT
        checkout_order.id,
        json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.currencyCode'),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.decimalPlaces') AS INTEGER),
        json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.displayLabel'),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.pricesIncludeTax') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.shippingTaxed') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.subtotalMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.shippingMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.discountMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.taxableMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.taxMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.totalMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.settingsVersion') AS INTEGER),
        json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.calculationVersion'),
        json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.destination'),
        json_object(
          'lines', json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.lines'),
          'shipping', json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.shipping')
        ),
        checkout_order.created_at
      FROM target_orders AS checkout_order
      WHERE 1 = 1
      ON CONFLICT(order_id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO order_item_tax_snapshots (
        order_item_id, order_id, tax_class_id, tax_class_name,
        unit_price_minor, quantity, gross_amount_minor, discount_minor,
        taxable_amount_minor, tax_minor, prices_include_tax,
        rate_snapshot, created_at
      )
      SELECT
        json_extract(item.value, '$.id'),
        checkout_order.id,
        json_extract(tax_line.value, '$.taxClassId'),
        json_extract(tax_line.value, '$.taxClassName'),
        CAST(json_extract(tax_line.value, '$.unitPriceMinor') AS INTEGER),
        CAST(json_extract(tax_line.value, '$.quantity') AS INTEGER),
        CAST(json_extract(tax_line.value, '$.grossAmountMinor') AS INTEGER),
        CAST(json_extract(tax_line.value, '$.discountMinor') AS INTEGER),
        CAST(json_extract(tax_line.value, '$.taxableAmountMinor') AS INTEGER),
        CAST(json_extract(tax_line.value, '$.taxMinor') AS INTEGER),
        CAST(json_extract(checkout_order.checkout_aggregate_payload, '$.payload.taxQuote.pricesIncludeTax') AS INTEGER),
        json_extract(tax_line.value, '$.components'),
        checkout_order.created_at
      FROM target_orders AS checkout_order
      CROSS JOIN json_each(
        checkout_order.checkout_aggregate_payload,
        '$.payload.items' /* scalius:postgres-jsonb */
      ) AS item
      JOIN json_each(
        checkout_order.checkout_aggregate_payload,
        '$.payload.taxQuote.lines' /* scalius:postgres-jsonb */
      ) AS tax_line
        ON json_extract(tax_line.value, '$.lineId')
         = json_extract(item.value, '$.taxAllocationLineId')
      WHERE 1 = 1
      ON CONFLICT(order_item_id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO cod_tracking (
        id, order_id, delivery_attempts, cod_status, created_at, updated_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.codTrackingId'),
        checkout_order.id,
        0,
        'pending',
        checkout_order.created_at,
        checkout_order.created_at
      FROM target_orders AS checkout_order
      WHERE checkout_order.payment_method = 'cod'
      ON CONFLICT(order_id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO order_notification_outbox (
        id, dedupe_key, order_id, notification_type, source, payload,
        status, attempts, next_attempt_at, created_at, updated_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.notificationOutboxId'),
        'order_created:' || checkout_order.id,
        checkout_order.id,
        'order_created',
        'storefront-checkout-aggregate',
        json_object(
          'type', 'order.notification',
          'orderId', checkout_order.id,
          'customerEmail', checkout_order.customer_email,
          'customerName', checkout_order.customer_name,
          'notificationType', 'order_created'
        ),
        'pending', 0, MAX(0, checkout_order.created_at - 1),
        checkout_order.created_at, checkout_order.created_at
      FROM target_orders AS checkout_order
      WHERE json_extract(
        checkout_order.checkout_aggregate_payload,
        '$.projection.notificationOutboxId'
      ) IS NOT NULL
      ON CONFLICT(dedupe_key) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      INSERT INTO meta_capi_purchase_outbox (
        id, order_id, event_id, source, status, attempts,
        next_attempt_at, created_at, updated_at
      )
      SELECT
        json_extract(checkout_order.checkout_aggregate_payload, '$.projection.metaPurchaseOutboxId'),
        checkout_order.id,
        'Purchase:' || checkout_order.id,
        'storefront-checkout-aggregate',
        'pending', 0, MAX(0, checkout_order.created_at - 1),
        checkout_order.created_at, checkout_order.created_at
      FROM target_orders AS checkout_order
      WHERE checkout_order.payment_method = 'cod'
        AND checkout_order.status NOT IN ('incomplete', 'cancelled', 'refunded', 'returned')
        AND json_extract(
          checkout_order.checkout_aggregate_payload,
          '$.projection.metaPurchaseOutboxId'
        ) IS NOT NULL
      ON CONFLICT(order_id) DO NOTHING`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      SELECT CASE WHEN NOT EXISTS (
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
            json_extract(
              checkout_order.checkout_aggregate_payload,
              '$.projection.notificationOutboxId'
            ) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM order_notification_outbox AS notification
              WHERE notification.dedupe_key = 'order_created:' || checkout_order.id
            )
          )
          OR (
            json_extract(
              checkout_order.checkout_aggregate_payload,
              '$.projection.metaPurchaseOutboxId'
            ) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM meta_capi_purchase_outbox AS meta
              WHERE meta.order_id = checkout_order.id
            )
          )
      )
      THEN 1
      ELSE json_extract('{}', 'CHECKOUT_PROJECTION_POSTCONDITION_FAILED')
      END`,
    args,
  }, {
    sql: `WITH ${TARGET_ORDERS_CTE}
      UPDATE orders
      SET
        checkout_projection_status = 'complete',
        checkout_projection_attempts = checkout_projection_attempts + 1,
        updated_at = MAX(updated_at, unixepoch())
      WHERE id IN (SELECT id FROM target_orders)`,
    args,
  }, {
    sql: `UPDATE checkout_batch_outbox
      SET
        status = 'complete',
        attempts = attempts + 1,
        claim_id = NULL,
        claim_expires_at = NULL,
        last_error = NULL,
        completed_at = unixepoch(),
        updated_at = unixepoch()
      WHERE id IN (
        SELECT CAST(value AS TEXT) FROM json_each(?1)
      )
        AND status IN ('pending', 'failed')`,
    args,
  }];
}

export function buildPendingCheckoutProjectionOutboxesStatement(
  limit = 25,
): PortableSqlStatement {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Checkout projection scan limit must be between 1 and 100.");
  }
  return {
    sql: `SELECT id, json_array_length(order_ids) AS orderCount
      FROM checkout_batch_outbox
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at, id
      LIMIT ?1`,
    args: [limit],
  };
}

export interface CheckoutProjectionRecoveryResult {
  scanned: number;
  completed: number;
  failed: number;
  /**
   * A full page means another bounded sweep may be useful. It deliberately
   * does not add a second hot-path count query.
   */
  hasMore: boolean;
}

export interface CheckoutProjectionAttemptResult {
  completedIds: string[];
  failedIds: string[];
}

/**
 * Project one bounded outbox group, isolating individual outboxes only when
 * the efficient grouped transaction fails. Live and scheduled recovery share
 * this policy so a large transient group never needs manual intervention.
 */
export async function projectCheckoutOutboxes(
  transport: Pick<CheckoutSqlTransport, "atomic">,
  outboxIds: readonly string[],
): Promise<CheckoutProjectionAttemptResult> {
  const groupedStatements = buildCheckoutProjectionBatchStatements(outboxIds);
  try {
    await transport.atomic(groupedStatements);
    return { completedIds: [...outboxIds], failedIds: [] };
  } catch {
    if (outboxIds.length === 1) {
      return { completedIds: [], failedIds: [...outboxIds] };
    }
  }

  const completedIds: string[] = [];
  const failedIds: string[] = [];
  for (const outboxId of outboxIds) {
    try {
      await transport.atomic(buildCheckoutProjectionStatements(outboxId));
      completedIds.push(outboxId);
    } catch {
      failedIds.push(outboxId);
    }
  }
  return { completedIds, failedIds };
}

/**
 * Recover committed checkout aggregates whose normalized read-model
 * projection was interrupted. Healthy outboxes share the same bounded
 * transaction shape as the live coordinator. A failed group falls back to
 * sequential isolation so one malformed historical row cannot block later
 * batches.
 */
export async function recoverPendingCheckoutProjections(
  transport: Pick<CheckoutSqlTransport, "all" | "atomic">,
  limit = 25,
): Promise<CheckoutProjectionRecoveryResult> {
  const rows = await transport.all<{ id: unknown; orderCount: unknown }>(
    buildPendingCheckoutProjectionOutboxesStatement(limit),
  );
  let completed = 0;
  let failed = 0;
  const valid: Array<{ id: string; orderCount: number }> = [];

  for (const row of rows) {
    const orderCount = Number(row.orderCount);
    if (
      typeof row.id !== "string"
      || !row.id.trim()
      || !Number.isSafeInteger(orderCount)
      || orderCount < 1
      || orderCount > CHECKOUT_COMMIT_HARD_MAX_ORDERS
    ) {
      failed += 1;
      continue;
    }
    valid.push({ id: row.id, orderCount });
  }

  const groups: Array<Array<{ id: string; orderCount: number }>> = [];
  let group: Array<{ id: string; orderCount: number }> = [];
  let groupOrders = 0;
  for (const candidate of valid) {
    if (
      group.length > 0
      && (
        group.length >= CHECKOUT_PROJECTION_MAX_OUTBOXES
        || groupOrders + candidate.orderCount > CHECKOUT_PROJECTION_MAX_ORDERS
      )
    ) {
      groups.push(group);
      group = [];
      groupOrders = 0;
    }
    group.push(candidate);
    groupOrders += candidate.orderCount;
  }
  if (group.length > 0) groups.push(group);

  for (const candidates of groups) {
    const result = await projectCheckoutOutboxes(
      transport,
      candidates.map((candidate) => candidate.id),
    );
    completed += result.completedIds.length;
    failed += result.failedIds.length;
  }

  return {
    scanned: rows.length,
    completed,
    failed,
    hasMore: rows.length === limit,
  };
}
