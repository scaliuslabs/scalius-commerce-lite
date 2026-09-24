import { sql, type SQL } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import { FIRST_ORDER_NUMBER, parseOrderNumberSearch } from "@scalius/shared/order-utils";

/**
 * The next sequential order number, evaluated inside the order INSERT itself so
 * it commits with the order. SQLite/D1 serialise writers and PostgreSQL writes
 * run SERIALIZABLE with retry; the unique index rejects any duplicate.
 */
export function nextOrderNumberSql(): SQL<number> {
    return sql<number>`(SELECT coalesce(max("order_number"), ${FIRST_ORDER_NUMBER - 1}) + 1 FROM "orders")`;
}

/** Exact order-number match for a search such as "#1001" or "১০০১". */
export function orderNumberSearchCondition(search: string): SQL | undefined {
    const orderNumber = parseOrderNumberSearch(search);
    return orderNumber === null ? undefined : sql`${orders.orderNumber} = ${orderNumber}`;
}
