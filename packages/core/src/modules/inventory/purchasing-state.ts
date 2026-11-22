// The purchase order and supplier machines live in `@scalius/shared/purchasing-state`,
// so the dashboard reads the same open set; this module adds the server's SQL form.
import { sql } from "drizzle-orm";
import { PURCHASE_ORDER_OPEN_STATUSES } from "@scalius/shared/purchasing-state";

export { PURCHASE_ORDER_MACHINE, PURCHASE_ORDER_OPEN_STATUSES, SUPPLIER_MACHINE } from "@scalius/shared/purchasing-state";

/** The open set as an SQL list for raw subqueries (constant states, never input). */
export const PURCHASE_ORDER_OPEN_SQL = sql.raw(PURCHASE_ORDER_OPEN_STATUSES.map((status) => `'${status}'`).join(", "));
