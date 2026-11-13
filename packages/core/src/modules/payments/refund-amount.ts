// The price increment binds a refund amount a person types, not money that
// goes back: a late payment, a line's exact total or its tax is returned as
// it was paid (processRefund takes any whole amount up to what was paid).
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, settings } from "@scalius/database/schema";
import { backupPriceIncrementSql, storeCurrencyOf } from "../markets";
import { currencyDocument, onStoreIncrementMinor, orderPricePolicy } from "../settings";
import { settingsDocumentsJoin } from "../../settings-store";

/**
 * Refuses a free amount a person typed (the dashboard's refund, naming no
 * lines) unless it is on the store's price increment in the order's currency:
 * "Taka amounts are whole numbers." in a whole-taka store. Everything still
 * paid is always allowed, whatever it is; an unknown order is left to the
 * refund to refuse. One statement: the order beside the store currency.
 */
export async function assertTypedRefundAmount(db: Database, orderId: string, amountMinor: number): Promise<void> {
    const rows = await db.select({
        paidMinor: orders.paidAmountMinor,
        code: orders.currencyCode,
        decimalPlaces: orders.currencyDecimalPlaces,
        backupPriceIncrementMinor: backupPriceIncrementSql(),
        category: settings.category,
        value: settings.value,
        revision: settings.revision,
    }).from(orders).leftJoin(settings, settingsDocumentsJoin([currencyDocument])).where(eq(orders.id, orderId));
    const order = rows[0];
    if (!order || amountMinor >= order.paidMinor) return;
    const storeDocument = (await currencyDocument.fromRows(rows.flatMap((row) => row.category === null || row.value === null
        ? []
        : [{ category: row.category, value: row.value, revision: row.revision ?? 0 }]))).value;
    const store = storeCurrencyOf(storeDocument, order.backupPriceIncrementMinor);
    onStoreIncrementMinor(amountMinor, orderPricePolicy({ code: order.code, decimalPlaces: order.decimalPlaces }, store));
}
