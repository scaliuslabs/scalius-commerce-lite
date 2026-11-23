// What a buyer's account reads cheaply at any order count (migration 0225),
// kept by triggers so no account read walks the buyer's orders:
//
// - `account_order_totals`: per account and currency, the live orders the
//   account owns that are not unfinished checkouts, and what the store still
//   holds of them (paid, already net of refunds, less what banks withdrew in
//   disputes, never below zero: the spend of @scalius/database/customer-spend
//   in the order's own currency). Each write that moves an order in or out of
//   the set, or changes its amount, recomputes the one (account, currency)
//   row it left and the one it joined.
// - `conversations.buyer_account_id`: the account that reads a thread on the
//   storefront. A storefront store thread is its customer's; an order-scoped
//   thread is its order owner's while the order is live. The buyer's list,
//   unread and open counts read the threads through it.
//
// Pure SQL text, no imports: the migration and its tests share it.

export interface BuyerAccountTrigger { name: string; table: string; sqlite: string }

/** An order's held amount in its own currency: paid less lost to disputes, never negative. */
const ORDER_HELD = "max(orders.paid_amount_minor - orders.disputed_minor, 0)";

/**
 * The (account, currency) row recomputed from that account's orders in that
 * currency, driven from `customers` as customer-spend.ts is: an account that
 * no longer exists (deleted, its orders being set null) or was erased writes
 * no row.
 */
function refreshTotals(account: string, currency: string): string {
  return `INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, ${currency}, count(orders.id), COALESCE(sum(${ORDER_HELD}), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = ${currency}
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = ${account} AND customers.erased_at IS NULL
    GROUP BY customers.id
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at`;
}

function trigger(name: string, event: string, table: string, guard: string, body: string): BuyerAccountTrigger {
  return { name, table, sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}\nWHEN ${guard}\nBEGIN\n  ${body};\nEND` };
}

/** Whether a row (`NEW` or `OLD`) is in its account's totals: owned, live, and not an unfinished checkout. */
const counted = (row: "NEW" | "OLD") =>
  `(${row}.account_owner_customer_id IS NOT NULL AND ${row}.deleted_at IS NULL AND ${row}.status <> 'incomplete')`;

/** The order columns an account's totals read: a change of any of them may move its rows. */
const TOTALS_MOVED = [
  "OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id",
  "OLD.currency_code IS NOT NEW.currency_code",
  "OLD.paid_amount_minor IS NOT NEW.paid_amount_minor",
  "OLD.disputed_minor IS NOT NEW.disputed_minor",
  "OLD.deleted_at IS NOT NEW.deleted_at",
  // A status counts only when the order is placed or goes back to an unfinished checkout.
  "(OLD.status IS NOT NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete'))",
].join(" OR ");

/**
 * The four triggers that keep `account_order_totals`. Each fires only when the
 * order is in a totals row before or after the write and a column the row
 * reads changed: an unfinished checkout's writes (its payment attempts, its
 * amounts) recompute nothing until it is placed.
 */
export function generateAccountOrderTotalsTriggers(): BuyerAccountTrigger[] {
  return [
    trigger("account_order_totals_order_ins", "INSERT", "orders", counted("NEW"),
      refreshTotals("NEW.account_owner_customer_id", "NEW.currency_code")),
    trigger("account_order_totals_order_upd", "UPDATE OF account_owner_customer_id, currency_code, paid_amount_minor, disputed_minor, deleted_at, status", "orders",
      `NEW.account_owner_customer_id IS NOT NULL AND (${counted("OLD")} OR ${counted("NEW")}) AND (${TOTALS_MOVED})`,
      refreshTotals("NEW.account_owner_customer_id", "NEW.currency_code")),
    // The row the order left, when it moved to another account or currency.
    trigger("account_order_totals_order_upd_old", "UPDATE OF account_owner_customer_id, currency_code", "orders",
      `${counted("OLD")} AND (OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR OLD.currency_code IS NOT NEW.currency_code)`,
      refreshTotals("OLD.account_owner_customer_id", "OLD.currency_code")),
    trigger("account_order_totals_order_del", "DELETE", "orders", counted("OLD"),
      refreshTotals("OLD.account_owner_customer_id", "OLD.currency_code")),
  ];
}

/** The account of an order-scoped thread: its order's owner while the order is live. */
const ORDER_OWNER = "(SELECT owner_order.account_owner_customer_id FROM orders AS owner_order WHERE owner_order.id = NEW.order_id AND owner_order.deleted_at IS NULL)";

/** The three triggers that keep `conversations.buyer_account_id`. */
export function generateConversationBuyerAccountTriggers(): BuyerAccountTrigger[] {
  return [
    // A storefront store thread (never a chat-channel one) is read by its customer.
    trigger("conversations_buyer_account_store", "INSERT", "conversations",
      "NEW.subject_type = 'store' AND NEW.channel IS NULL AND NEW.customer_id IS NOT NULL",
      "UPDATE conversations SET buyer_account_id = NEW.customer_id WHERE id = NEW.id"),
    // An order, warranty-claim or review thread follows its order.
    trigger("conversations_buyer_account_order", "INSERT", "conversations",
      "NEW.subject_type <> 'store' AND NEW.order_id IS NOT NULL",
      `UPDATE conversations SET buyer_account_id = ${ORDER_OWNER} WHERE id = NEW.id`),
    // A claimed, moved, deleted or restored order carries its threads.
    trigger("orders_conversations_buyer_account", "UPDATE OF account_owner_customer_id, deleted_at", "orders",
      "OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)",
      "UPDATE conversations SET buyer_account_id = (CASE WHEN NEW.deleted_at IS NULL THEN NEW.account_owner_customer_id END) WHERE order_id = NEW.id AND subject_type <> 'store'"),
  ];
}

/** The rows as the triggers keep them, for orders and threads that exist before the triggers. */
export const BUYER_ACCOUNT_BACKFILL = [
  // One row per (account, currency) with a counted order; an owner id with no customer row is skipped.
  `INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, orders.currency_code, count(orders.id), COALESCE(sum(${ORDER_HELD}), 0), unixepoch()
    FROM orders INNER JOIN customers ON customers.id = orders.account_owner_customer_id
    WHERE orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    GROUP BY customers.id, orders.currency_code`,
  // One write per storefront store thread, then one per order-scoped thread.
  "UPDATE conversations SET buyer_account_id = customer_id WHERE subject_type = 'store' AND channel IS NULL AND customer_id IS NOT NULL",
  `UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order
    WHERE owner_order.id = conversations.order_id AND owner_order.deleted_at IS NULL)
    WHERE subject_type <> 'store' AND order_id IS NOT NULL`,
] as const;
