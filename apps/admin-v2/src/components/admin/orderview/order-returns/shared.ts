import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { OrderItem } from "../types";

let fallbackCommandCounter = 0;

export function createReturnCommandKey(action: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `return:${action}:${globalThis.crypto.randomUUID()}`;
  }
  fallbackCommandCounter += 1;
  return `return:${action}:${Date.now().toString(36)}:${fallbackCommandCounter.toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/** A typed quantity (from `NumberInput`) as a whole number between 0 and `max`; empty or not a number is 0. */
export function clampQuantity(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

export function getOrderItemName(item: OrderItem | undefined): string {
  if (!item) return translate(orderDetailMessages, "items.unknown");
  return [item.productName || translate(orderDetailMessages, "items.unnamed"), item.variantLabel]
    .filter(Boolean)
    .join(" · ");
}
