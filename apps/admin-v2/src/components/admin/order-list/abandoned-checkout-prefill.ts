import type { ParsedAbandonedCheckoutDisplay } from "~/lib/abandoned-checkout-display";
import { foreignAddress, ORDER_PREFILL_STORAGE_KEY, type OrderPrefill } from "~/components/admin/order-form/order-prefill";

function text(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The create-order values from an abandoned checkout: who, where to and what
 * was in the cart. The checkout stored city/zone/area ids next to their names.
 */
export function buildOrderPrefill(
  checkoutData: string,
  display: Pick<ParsedAbandonedCheckoutDisplay, "customerInfo" | "items">,
  checkoutId?: string | null,
): OrderPrefill {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(checkoutData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Unreadable checkout: only what the display could recover.
  }
  const { customerInfo } = display;
  // The storefront saves the chosen rate as `shipping: { id, fee }`, the fee after any free-delivery threshold.
  const shipping = data.shipping && typeof data.shipping === "object" ? data.shipping as Record<string, unknown> : {};
  const fee = typeof shipping.fee === "number" && Number.isFinite(shipping.fee) && shipping.fee >= 0 ? shipping.fee : null;
  return {
    customerName: customerInfo.name?.trim() ?? "",
    customerPhone: customerInfo.phone ?? "",
    customerEmail: customerInfo.email?.trim() || null,
    shippingAddress: customerInfo.address?.trim() ?? "",
    ...foreignAddress(data),
    city: text(data, "city"),
    zone: text(data, "zone"),
    area: text(data, "area") || null,
    // The names the checkout showed: the pickers label the choice with them.
    ...(text(data, "cityName") ? { cityName: text(data, "cityName") } : {}),
    ...(text(data, "zoneName") ? { zoneName: text(data, "zoneName") } : {}),
    ...(text(data, "areaName") ? { areaName: text(data, "areaName") } : {}),
    shippingMethodId: fee === null ? null : text(shipping, "id") || null,
    shippingCharge: fee,
    // The SKUs, quantities, inputs and the price the buyer saw; the form prices them today.
    items: display.items.map((item) => ({
      productId: item.id,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      name: item.variantLabel ? `${item.name} (${item.variantLabel})` : item.name,
      price: item.price,
      ...(item.properties?.length ? { properties: item.properties } : {}),
    })),
    ...(checkoutId?.trim() ? { abandonedCheckoutId: checkoutId.trim() } : {}),
  };
}

/** Hands the values to the create-order form; false when storage is blocked. */
export function writeOrderPrefill(prefill: OrderPrefill): boolean {
  try {
    sessionStorage.setItem(ORDER_PREFILL_STORAGE_KEY, JSON.stringify(prefill));
    return true;
  } catch {
    return false;
  }
}

/** A short readable reference for a checkout: the last 6 characters of its id. */
export function checkoutReference(id: string | null | undefined): string {
  const compact = (id ?? "").trim().replace(/^chk_session_/i, "");
  return compact ? compact.slice(-6) : "—";
}
