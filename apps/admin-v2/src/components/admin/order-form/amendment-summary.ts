import { translate } from "~/i18n";
import { orderFormMessages, type OrderFormMessageKey } from "~/i18n/order-form";
import type { OrderItem } from "./types";

interface OrderSide {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string | null;
  shippingAddress?: string;
  city?: string;
  zone?: string;
  area?: string | null;
  notes?: string | null;
  discountAmount?: number | null;
  shippingCharge?: number;
  items?: OrderItem[];
}

const lineKey = (item: OrderItem) => `${item.productId}:${item.variantId ?? ""}`;
const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

/**
 * What an amendment changes, in short plain lines for the review dialog:
 * added/removed quantities per product, delivery charge, discount, and whether
 * the customer, address or notes changed.
 */
export function describeAmendment(
  before: OrderSide,
  after: OrderSide,
  nameOf: (item: OrderItem) => string,
  money: (amount: number) => string,
): string[] {
  const t = (key: OrderFormMessageKey, vars?: Record<string, string | number>) =>
    translate(orderFormMessages, key, vars);
  const quantities = new Map<string, { item: OrderItem; delta: number }>();
  for (const [items, sign] of [[before.items ?? [], -1], [after.items ?? [], 1]] as const) {
    for (const item of items) {
      const entry = quantities.get(lineKey(item)) ?? { item, delta: 0 };
      entry.delta += sign * item.quantity;
      if (sign === 1) entry.item = item;
      quantities.set(lineKey(item), entry);
    }
  }
  const changes: string[] = [];
  for (const { item, delta } of quantities.values()) {
    if (delta > 0) changes.push(t("changeAdded", { quantity: delta, name: nameOf(item) }));
    if (delta < 0) changes.push(t("changeRemoved", { quantity: -delta, name: nameOf(item) }));
  }
  const shippingBefore = before.shippingCharge ?? 0;
  const shippingAfter = after.shippingCharge ?? 0;
  if (shippingBefore !== shippingAfter) {
    changes.push(t("changeDelivery", { before: money(shippingBefore), after: money(shippingAfter) }));
  }
  const discountBefore = before.discountAmount ?? 0;
  const discountAfter = after.discountAmount ?? 0;
  if (discountBefore !== discountAfter) {
    changes.push(t("changeDiscount", { before: money(discountBefore), after: money(discountAfter) }));
  }
  if (!same(before.customerName, after.customerName)
    || !same(before.customerPhone, after.customerPhone)
    || !same(before.customerEmail, after.customerEmail)) {
    changes.push(t("changeCustomer"));
  }
  if (!same(before.shippingAddress, after.shippingAddress)
    || !same(before.city, after.city)
    || !same(before.zone, after.zone)
    || !same(before.area, after.area)) {
    changes.push(t("changeAddress"));
  }
  if (!same(before.notes, after.notes)) changes.push(t("changeNotes"));
  return changes;
}
