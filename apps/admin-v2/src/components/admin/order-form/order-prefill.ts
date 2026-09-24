import type { OrderItem } from "./types";

/** Written by the abandoned-checkout "Create order" action, read once here. */
export const ORDER_PREFILL_STORAGE_KEY = "admin.orderPrefill";

export interface OrderPrefill {
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  items: OrderItem[];
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Takes the prefill out of session storage (it is removed even when it can't
 * be read) and keeps only well-formed values. Lines are priced by the quote.
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
  const items = (Array.isArray(value.items) ? value.items : []).flatMap((entry): OrderItem[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const quantity = Number(item.quantity);
    if (!text(item.productId) || !text(item.variantId) || !Number.isInteger(quantity) || quantity < 1) {
      return [];
    }
    return [{
      productId: text(item.productId),
      variantId: text(item.variantId),
      quantity: Math.min(quantity, 99),
      price: 0,
      name: text(item.productName) || undefined,
      variantLabel: text(item.variantLabel) || null,
    }];
  });
  return {
    customerName: text(value.customerName),
    customerPhone: text(value.customerPhone),
    customerEmail: text(value.customerEmail) || null,
    shippingAddress: text(value.shippingAddress),
    city: text(value.city),
    zone: text(value.zone),
    area: text(value.area) || null,
    items,
  };
}
