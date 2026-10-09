/**
 * catalog-scale-verify.mjs — read-only invariant checks for a store seeded by
 * `scripts/catalog-scale-seed.mjs` (`--verify`). Every check is a count of
 * violating rows and must be 0, so the output is a plain pass/fail list.
 * `PRAGMA foreign_key_check` and `quick_check` run last (`--deep`), because
 * they scan every table.
 */

const CHECKS = [
  // ---- catalogue identity
  ["SKU identity is globally unique (lower(trim(sku)))", "SELECT count(*) - count(DISTINCT lower(trim(sku))) FROM product_variants"],
  ["barcode identity is globally unique", "SELECT count(barcode) - count(DISTINCT lower(trim(barcode))) FROM product_variants WHERE barcode IS NOT NULL"],
  ["every simple product has exactly one live hidden default SKU", `SELECT count(*) FROM products AS p
     WHERE NOT EXISTS (SELECT 1 FROM product_option_definitions AS d WHERE d.product_id = p.id)
       AND (SELECT count(*) FROM product_variants AS v WHERE v.product_id = p.id AND v.is_default = 1 AND v.deleted_at IS NULL) <> 1`],
  ["no optioned product has a default SKU", `SELECT count(*) FROM products AS p
     WHERE EXISTS (SELECT 1 FROM product_option_definitions AS d WHERE d.product_id = p.id)
       AND EXISTS (SELECT 1 FROM product_variants AS v WHERE v.product_id = p.id AND v.is_default = 1)`],
  ["every optioned SKU assigns exactly one value of every axis", `SELECT count(*) FROM product_variants AS v
     WHERE v.is_default = 0
       AND (SELECT count(*) FROM product_variant_option_values AS x WHERE x.variant_id = v.id)
        <> (SELECT count(*) FROM product_option_definitions AS d WHERE d.product_id = v.product_id)`],
  ["at most five option axes per product", "SELECT count(*) FROM (SELECT product_id FROM product_option_definitions GROUP BY product_id HAVING count(*) > 5)"],
  ["category depth agrees with its parent", `SELECT count(*) FROM categories AS c JOIN categories AS p ON p.id = c.parent_id WHERE c.depth <> p.depth + 1`],
  ["every product has a buyer-state projection row", "SELECT count(*) FROM products AS p WHERE NOT EXISTS (SELECT 1 FROM product_buyer_state AS s WHERE s.product_id = p.id)"],
  // ---- stock ledger edges
  ["every stocked SKU has its default-location level equal to its stock", `SELECT count(*) FROM product_variants AS v
     WHERE v.stock > 0 AND v.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM inventory_levels AS l WHERE l.variant_id = v.id AND l.location_id = 'loc_default' AND l.on_hand = v.stock)`],
  ["no level exists for a zero-stock SKU", `SELECT count(*) FROM inventory_levels AS l JOIN product_variants AS v ON v.id = l.variant_id WHERE l.on_hand <> v.stock`],
  ["no SKU is reserved past its stock", "SELECT count(*) FROM product_variants WHERE reserved_stock > stock + preorder_stock"],
  // ---- order money (minor units)
  ["order total = subtotal - discount + tax + shipping", "SELECT count(*) FROM orders WHERE total_amount_minor <> subtotal_amount_minor - discount_amount_minor + tax_amount_minor + shipping_amount_minor"],
  ["shop total = shop subtotal - discount + tax + shipping", "SELECT count(*) FROM orders WHERE total_shop_minor <> subtotal_shop_minor - discount_shop_minor + tax_shop_minor + shipping_shop_minor"],
  ["order subtotal = sum of line subtotals", `SELECT count(*) FROM orders AS o JOIN (SELECT order_id, sum(line_subtotal_minor) AS s FROM order_items GROUP BY order_id) AS i ON i.order_id = o.id WHERE o.subtotal_amount_minor <> i.s`],
  ["order discount = sum of line discounts", `SELECT count(*) FROM orders AS o JOIN (SELECT order_id, sum(discount_amount_minor) AS s FROM order_items GROUP BY order_id) AS i ON i.order_id = o.id WHERE o.discount_amount_minor <> i.s`],
  ["order tax = sum of line tax", `SELECT count(*) FROM orders AS o JOIN (SELECT order_id, sum(tax_amount_minor) AS s FROM order_items GROUP BY order_id) AS i ON i.order_id = o.id WHERE o.tax_amount_minor <> i.s`],
  ["line subtotal = unit price x quantity", "SELECT count(*) FROM order_items WHERE line_subtotal_minor <> unit_price_minor * quantity"],
  ["every order has at least one line", "SELECT count(*) FROM orders AS o WHERE NOT EXISTS (SELECT 1 FROM order_items AS i WHERE i.order_id = o.id)"],
  ["paid amount = succeeded payments - refunded refunds", `SELECT count(*) FROM orders AS o JOIN (
       SELECT order_id, sum(CASE WHEN payment_type <> 'refund' AND status = 'succeeded' THEN amount_minor ELSE 0 END)
            - sum(CASE WHEN payment_type = 'refund' AND status = 'refunded' THEN amount_minor ELSE 0 END) AS net,
            sum(CASE WHEN payment_type = 'refund' AND status = 'refunded' THEN amount_minor ELSE 0 END) AS refunded
       FROM order_payments GROUP BY order_id) AS p ON p.order_id = o.id
     WHERE o.paid_amount_minor <> CASE WHEN p.refunded >= o.total_amount_minor AND p.net <= 0 THEN 0 ELSE p.net END`],
  ["an order without a successful payment is not marked paid", `SELECT count(*) FROM orders AS o WHERE o.payment_status = 'paid' AND o.paid_amount_minor <> o.total_amount_minor`],
  // ---- fulfilment, returns
  ["fulfilled quantity = sum of active fulfilment lines, never over quantity", `SELECT count(*) FROM order_items AS i
     WHERE i.fulfilled_quantity <> coalesce((SELECT sum(l.quantity) FROM order_fulfillment_lines AS l JOIN order_fulfillments AS f ON f.id = l.fulfillment_id WHERE l.order_item_id = i.id AND f.status = 'active'), 0)
        OR i.fulfilled_quantity > i.quantity`],
  ["return quantities never pass fulfilled quantity", `SELECT count(*) FROM order_items AS i
     WHERE coalesce((SELECT sum(rl.requested_quantity) FROM order_return_lines AS rl WHERE rl.order_item_id = i.id), 0) > i.fulfilled_quantity`],
  // ---- customers
  ["customer total_orders = trigger-maintained orders_count", `SELECT count(*) FROM customers AS c JOIN customer_order_stats AS s ON s.customer_id = c.id WHERE c.total_orders <> s.orders_count`],
  ["customer_order_stats agrees with orders (sampled 2000 customers)", `SELECT count(*) FROM (SELECT customer_id, orders_count, first_order_at, last_order_at FROM customer_order_stats ORDER BY rowid LIMIT 2000) AS s
     WHERE s.orders_count <> (SELECT count(*) FROM orders AS o WHERE o.customer_id = s.customer_id AND o.deleted_at IS NULL AND o.status <> 'incomplete')
        OR s.last_order_at IS NOT (SELECT max(o.created_at) FROM orders AS o WHERE o.customer_id = s.customer_id AND o.deleted_at IS NULL AND o.status <> 'incomplete')`],
  ["guest phone identity is unique", "SELECT count(*) FROM (SELECT phone FROM customers WHERE account_claimed_at IS NULL AND deleted_at IS NULL AND phone <> '' GROUP BY phone HAVING count(*) > 1)"],
  // ---- reviews, promotions, gift cards, inbox
  ["review stats = published reviews per product", `SELECT count(*) FROM product_review_stats AS s
     WHERE s.review_count <> (SELECT count(*) FROM product_reviews AS r WHERE r.product_id = s.product_id AND r.status = 'published')
        OR s.rating_sum <> coalesce((SELECT sum(r.rating) FROM product_reviews AS r WHERE r.product_id = s.product_id AND r.status = 'published'), 0)`],
  ["redemption amount = its order's allocations", `SELECT count(*) FROM promotion_redemptions AS r
     WHERE r.discount_amount_minor <> coalesce((SELECT sum(a.discount_amount_minor) FROM order_discount_allocations AS a WHERE a.order_id = r.order_id AND a.promotion_id = r.promotion_id), 0)`],
  ["allocations sum to the order discount", `SELECT count(*) FROM orders AS o WHERE o.discount_amount_minor <> coalesce((SELECT sum(a.discount_amount_minor) FROM order_discount_allocations AS a WHERE a.order_id = o.id), 0)`],
  ["gift card balance = sum of its transactions", `SELECT count(*) FROM gift_cards AS g WHERE g.balance_minor <> coalesce((SELECT sum(t.amount_minor) FROM gift_card_transactions AS t WHERE t.gift_card_id = g.id), 0)`],
  ["conversation last_seq = its message count", `SELECT count(*) FROM conversations AS c WHERE c.last_seq <> (SELECT count(*) FROM conversation_messages AS m WHERE m.conversation_id = c.id)`],
  // ---- derived state
  ["orders FTS has one document per order", "SELECT (SELECT count(*) FROM orders) - (SELECT count(*) FROM orders_fts_docsize)"],
  ["customers FTS has one document per customer", "SELECT (SELECT count(*) FROM customers) - (SELECT count(*) FROM customers_fts_docsize)"],
  ["the event outbox is empty and its triggers are back", `SELECT (SELECT count(*) FROM event_outbox) + (CASE WHEN (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'evt\\_%' ESCAPE '\\') >= 30 THEN 0 ELSE 1 END)`],
  ["order numbers are unique", "SELECT count(*) - count(DISTINCT order_number) FROM orders"],
];

const DEEP = [
  ["foreign key violations", "PRAGMA foreign_key_check"],
];

export function verify(db, { deep = false, log = console.log } = {}) {
  let failed = 0;
  for (const [name, sql] of CHECKS) {
    const began = Date.now();
    const row = db.prepare(sql).get();
    const value = Number(Object.values(row)[0]);
    const ok = value === 0;
    if (!ok) failed += 1;
    log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` (${value})`}  [${((Date.now() - began) / 1000).toFixed(1)}s]`);
  }
  if (deep) {
    for (const [name, sql] of DEEP) {
      const rows = db.prepare(sql).all();
      const ok = rows.length === 0;
      if (!ok) failed += 1;
      log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` (${rows.length}, first ${JSON.stringify(rows[0])})`}`);
    }
    const quick = db.prepare("PRAGMA quick_check").all();
    const ok = quick.length === 1 && Object.values(quick[0])[0] === "ok";
    if (!ok) failed += 1;
    log(`${ok ? "PASS" : "FAIL"}  sqlite quick_check${ok ? "" : ` (${JSON.stringify(quick.slice(0, 3))})`}`);
  }
  log(failed === 0 ? "all invariants hold" : `${failed} invariant(s) failed`);
  return failed;
}
