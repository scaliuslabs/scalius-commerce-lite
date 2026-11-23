import { LINE_BUNDLE_KEY, lineEntryWords } from "@scalius/shared/line-entry-words";
import { getLocale, translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { OrderItem } from "../types";

/** A typed quantity (from `NumberInput`) as a whole number between 0 and `max`; empty or not a number is 0. */
export function clampQuantity(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

/**
 * A line's name in a list of lines to return or refund: the product and its
 * SKU, then the bundle it was bought in ("Bundle: Tea set") so that one item
 * of a bundle reads as that bundle's, in the dashboard's language.
 */
export function getOrderItemName(item: OrderItem | undefined): string {
  if (!item) return translate(orderDetailMessages, "items.unknown");
  const bundle = item.properties?.find((property) => property.key === LINE_BUNDLE_KEY);
  return [
    item.productName || translate(orderDetailMessages, "items.unnamed"),
    item.variantLabel,
    bundle ? `${translate(orderDetailMessages, "properties.label", { label: lineEntryWords(getLocale()).lineBundleText })} ${bundle.displayValue}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
