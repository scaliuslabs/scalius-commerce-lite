// What a customer spent (`customer_order_stats.total_spent_minor`, the
// customer list, segments and the discounts keyed to them): each live,
// placed order's paid amount (already net of refunds) less what banks
// withdrew from it in disputes and kept (`orders.disputed_minor`), never
// below zero, in the shop currency. Migration 0220 replaces the 0123
// triggers with these; every write that moves either amount refreshes the
// customer's row. Pure SQL text, no imports: the migration and its tests
// share it.

/** An order's spend in its own currency: paid less lost to disputes, never negative. */
const ORDER_SPEND = "max(orders.paid_amount_minor - orders.disputed_minor, 0)";

/** One order's spend in the shop currency (a market order converts at its locked totals). */
const SHOP_SPEND = `(CASE WHEN orders.currency_code = orders.shop_currency OR orders.total_amount_minor <= 0 THEN ${ORDER_SPEND}
    ELSE CAST(round(${ORDER_SPEND} * 1.0 * orders.total_shop_minor / orders.total_amount_minor) AS INTEGER) END)`;

/** The customer's whole row, recomputed from their orders, for the customer `customerId` (an SQL expression). */
function refreshCustomer(customerId: string): string {
  return `INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, first_order_at, last_order_at, updated_at)
    SELECT customers.id, count(orders.id), COALESCE(sum(${SHOP_SPEND}), 0),
      min(CAST(orders.created_at AS INTEGER)), max(CAST(orders.created_at AS INTEGER)), unixepoch()
    FROM customers LEFT JOIN orders ON orders.customer_id = customers.id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = ${customerId}
    GROUP BY customers.id
    ON CONFLICT (customer_id) DO UPDATE SET orders_count = excluded.orders_count, total_spent_minor = excluded.total_spent_minor,
      first_order_at = excluded.first_order_at, last_order_at = excluded.last_order_at, updated_at = excluded.updated_at`;
}

export interface CustomerSpendTrigger { name: string; table: string; sqlite: string }

function trigger(name: string, event: string, guard: string, body: string): CustomerSpendTrigger {
  return { name, table: "orders", sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON orders\nWHEN ${guard}\nBEGIN\n  ${body};\nEND` };
}

/** The four triggers that keep a customer's order count and spend (they replace 0123's, same names). */
export function generateCustomerSpendTriggers(): CustomerSpendTrigger[] {
  const moved = [
    "OLD.customer_id IS NOT NEW.customer_id",
    "OLD.paid_amount_minor IS NOT NEW.paid_amount_minor",
    "OLD.disputed_minor IS NOT NEW.disputed_minor",
    "OLD.deleted_at IS NOT NEW.deleted_at",
    "OLD.created_at IS NOT NEW.created_at",
    "(OLD.status IS NOT NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete'))",
    "(NEW.currency_code <> NEW.shop_currency AND (OLD.total_shop_minor IS NOT NEW.total_shop_minor OR OLD.total_amount_minor IS NOT NEW.total_amount_minor))",
  ].join(" OR ");
  return [
    trigger("customer_order_stats_order_ins", "INSERT", "NEW.customer_id IS NOT NULL", refreshCustomer("NEW.customer_id")),
    trigger("customer_order_stats_order_upd", "UPDATE", `NEW.customer_id IS NOT NULL AND (${moved})`, refreshCustomer("NEW.customer_id")),
    trigger("customer_order_stats_order_upd_old", "UPDATE", "OLD.customer_id IS NOT NULL AND OLD.customer_id IS NOT NEW.customer_id", refreshCustomer("OLD.customer_id")),
    trigger("customer_order_stats_order_del", "DELETE", "OLD.customer_id IS NOT NULL", refreshCustomer("OLD.customer_id")),
  ];
}

/**
 * Recomputes the spend of every customer with an order a dispute took money
 * from: nothing on a store with no disputes (every `disputed_minor` is 0).
 */
export function customerSpendBackfillStatement(): string {
  return `UPDATE customer_order_stats SET total_spent_minor = COALESCE((
    SELECT sum(${SHOP_SPEND}) FROM orders
    WHERE orders.customer_id = customer_order_stats.customer_id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
  ), 0), updated_at = unixepoch()
  WHERE customer_id IN (SELECT orders.customer_id FROM orders WHERE orders.disputed_minor > 0 AND orders.customer_id IS NOT NULL)`;
}
