import { sql, type SQL } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import { parseOrderNumberSearch } from "@scalius/shared/order-utils";

export { nextOrderNumberSql } from "@scalius/database/client";

/** Exact order-number match for a search such as "#1001" or "১০০১". */
export function orderNumberSearchCondition(search: string): SQL | undefined {
    const orderNumber = parseOrderNumberSearch(search);
    return orderNumber === null ? undefined : sql`${orders.orderNumber} = ${orderNumber}`;
}
