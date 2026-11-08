import type { StoredOrderLine } from "./order-line";

/** Written by the abandoned-checkout "Create order" action, read once here. */
export const ORDER_PREFILL_STORAGE_KEY = "admin.orderPrefill";

export interface OrderPrefill {
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  /** Another country's address (absent: Bangladesh, with City/Thana/Area). */
  shippingCountryCode?: string;
  shippingAddressLine2?: string;
  shippingDependentLocality?: string;
  shippingLocality?: string;
  shippingAdminArea?: string;
  shippingPostalCode?: string;
  city: string;
  zone: string;
  area: string | null;
  /** The places' names, so the pickers show the buyer's choice before anything is searched. */
  cityName?: string;
  zoneName?: string;
  areaName?: string;
  shippingMethodId: string | null;
  shippingCharge: number | null;
  /** The SKUs and quantities only: the form prices them today (`restoreOrderLines`). */
  items: StoredOrderLine[];
  /** The abandoned checkout session the order completes: creating the order deletes its snapshot. */
  abandonedCheckoutId?: string;
}

/** A storefront checkout session id, as the API accepts it for `abandonedCheckoutId`. */
const CHECKOUT_SESSION_ID = /^chk_session_[A-Za-z0-9_-]{16,64}$/;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const FOREIGN_FIELDS = [
  "shippingAddressLine2", "shippingDependentLocality", "shippingLocality", "shippingAdminArea", "shippingPostalCode",
] as const;

/** Another country's address fields, when the prefill has a country other than Bangladesh. */
export function foreignAddress(value: Record<string, unknown>): Partial<OrderPrefill> {
  const country = text(value.shippingCountryCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === "BD") return {};
  return {
    shippingCountryCode: country,
    ...Object.fromEntries(FOREIGN_FIELDS.map((field) => [field, text(value[field])])),
  };
}

/**
 * Takes the prefill out of session storage (it is removed even when it can't
 * be read) and keeps only well-formed values. Its lines carry no price the
 * form uses: they are priced today when they go back on the order.
 */
export function takeOrderPrefill(): OrderPrefill | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(ORDER_PREFILL_STORAGE_KEY);
    window.sessionStorage.removeItem(ORDER_PREFILL_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const items = (Array.isArray(value.items) ? value.items : []).flatMap((entry): StoredOrderLine[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const quantity = Number(item.quantity);
    if (!text(item.productId) || !Number.isInteger(quantity) || quantity < 1) {
      return [];
    }
    const properties = (Array.isArray(item.properties) ? item.properties : []).flatMap((property) => {
      const entry = (property ?? {}) as Record<string, unknown>;
      return typeof entry.key === "string" && typeof entry.value === "string" ? [{ key: entry.key, value: entry.value }] : [];
    });
    return [{
      productId: text(item.productId),
      // A line without its SKU still comes through, to be named as one that couldn't be added.
      variantId: text(item.variantId) || null,
      quantity: Math.min(quantity, 99),
      ...(text(item.name) ? { name: text(item.name) } : {}),
      ...(typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 ? { price: item.price } : {}),
      ...(properties.length > 0 ? { properties } : {}),
    }];
  });
  return {
    customerName: text(value.customerName),
    customerPhone: text(value.customerPhone),
    customerEmail: text(value.customerEmail) || null,
    shippingAddress: text(value.shippingAddress),
    ...foreignAddress(value),
    city: text(value.city),
    zone: text(value.zone),
    area: text(value.area) || null,
    ...(text(value.cityName) ? { cityName: text(value.cityName) } : {}),
    ...(text(value.zoneName) ? { zoneName: text(value.zoneName) } : {}),
    ...(text(value.areaName) ? { areaName: text(value.areaName) } : {}),
    shippingMethodId: text(value.shippingMethodId) || null,
    shippingCharge: typeof value.shippingCharge === "number" && Number.isFinite(value.shippingCharge) && value.shippingCharge >= 0
      ? value.shippingCharge
      : null,
    items,
    ...(CHECKOUT_SESSION_ID.test(text(value.abandonedCheckoutId)) ? { abandonedCheckoutId: text(value.abandonedCheckoutId) } : {}),
  };
}
