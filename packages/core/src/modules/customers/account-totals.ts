// A buyer account's order count and spend, read from `account_order_totals`
// (migration 0225, kept by @scalius/database/buyer-account triggers): one row
// per currency the account bought in, whatever the number of orders.
import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { accountOrderTotals } from "@scalius/database/schema";

export interface AccountOrderTotals {
  /** Live orders the account owns that are not unfinished checkouts. */
  orders: number;
  /** What the store holds of those orders per currency (paid, net of refunds, less disputes lost), in minor units. */
  spent: Array<{ currencyCode: string; orders: number; amountMinor: number }>;
}

/** One indexed read (the table's primary key, by account). */
export async function readAccountOrderTotals(db: Database, customerId: string): Promise<AccountOrderTotals> {
  const rows = await db.select({
    currencyCode: accountOrderTotals.currencyCode,
    orders: accountOrderTotals.ordersCount,
    amountMinor: accountOrderTotals.spentMinor,
  }).from(accountOrderTotals)
    .where(and(eq(accountOrderTotals.customerId, customerId), gt(accountOrderTotals.ordersCount, 0)))
    .orderBy(asc(accountOrderTotals.currencyCode))
    .all();
  const spent = rows.map((row) => ({ currencyCode: row.currencyCode, orders: Number(row.orders), amountMinor: Number(row.amountMinor) }));
  return { orders: spent.reduce((sum, row) => sum + row.orders, 0), spent };
}
