// A manual order's priced lines in the shape the apps' checkout functions
// take (`ManualOrderAppFunctions`, injected by the API: the checkout module
// implements it, so orders stays free of checkout).
import type { ManualOrderAppLine } from "@scalius/shared/checkout-app-facts";

/** A manual order's priced lines as apps see them, by their tax allocation line ids. */
export function manualOrderAppLines(
    items: ReadonlyArray<Omit<ManualOrderAppLine, "lineId" | "isGiftCard"> & { isGiftCard?: boolean }>,
    lineIds: readonly string[],
): ManualOrderAppLine[] {
    return items.map((item, index) => ({
        lineId: lineIds[index]!,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantLabel: item.variantLabel,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        isGiftCard: item.isGiftCard === true,
        properties: item.properties,
    }));
}
