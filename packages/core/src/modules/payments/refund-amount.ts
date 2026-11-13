// The price increment binds a refund amount a person types, not money that
// goes back: a late payment, a line's exact total or its tax is returned as
// it was paid (processRefund takes any whole amount up to what was paid).
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { readStoreCurrency } from "../markets";
import { onStoreIncrementMinor, orderPricePolicy } from "../settings";

/**
 * Refuses a free amount a person typed (the dashboard's refund, naming no
 * lines) unless it is on the store's price increment in the order's currency:
 * "Taka amounts are whole numbers." in a whole-taka store. Everything still
 * paid is always allowed, whatever it is; an unknown order is left to the
 * refund to refuse.
 */
export async function assertTypedRefundAmount(db: Database, orderId: string, amountMinor: number): Promise<void> {
    const order = await db.select({
        paidMinor: orders.paidAmountMinor,
        code: orders.currencyCode,
        decimalPlaces: orders.currencyDecimalPlaces,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || amountMinor >= order.paidMinor) return;
    onStoreIncrementMinor(amountMinor, orderPricePolicy({ code: order.code, decimalPlaces: order.decimalPlaces }, await readStoreCurrency(db)));
}
