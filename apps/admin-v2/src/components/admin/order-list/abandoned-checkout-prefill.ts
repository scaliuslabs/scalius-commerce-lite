import type { ParsedAbandonedCheckoutDisplay } from "~/lib/abandoned-checkout-display";

/** sessionStorage key the create-order form reads (and removes) once on mount. */
export const ORDER_PREFILL_KEY = "admin.orderPrefill";

export interface OrderPrefill {
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  items: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
    productName?: string;
    variantLabel?: string | null;
  }>;
}

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
): OrderPrefill {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(checkoutData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Unreadable checkout: only what the display could recover.
  }
  const { customerInfo } = display;
  return {
    customerName: customerInfo.name?.trim() ?? "",
    customerPhone: customerInfo.phone ?? "",
    customerEmail: customerInfo.email?.trim() || null,
    shippingAddress: customerInfo.address?.trim() ?? "",
    city: text(data, "city"),
    zone: text(data, "zone"),
    area: text(data, "area") || null,
    items: display.items.map((item) => ({
      productId: item.id,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      productName: item.name,
      variantLabel: item.options?.length
        ? item.options.map((option) => `${option.name}: ${option.value}`).join(", ")
        : null,
    })),
  };
}

/** Hands the values to the create-order form; false when storage is blocked. */
export function writeOrderPrefill(prefill: OrderPrefill): boolean {
  try {
    sessionStorage.setItem(ORDER_PREFILL_KEY, JSON.stringify(prefill));
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
