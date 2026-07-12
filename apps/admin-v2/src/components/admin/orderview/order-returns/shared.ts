import type { OrderItem } from "../types";

let fallbackCommandCounter = 0;

export function createReturnCommandKey(action: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `return:${action}:${globalThis.crypto.randomUUID()}`;
  }
  fallbackCommandCounter += 1;
  return `return:${action}:${Date.now().toString(36)}:${fallbackCommandCounter.toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function parseReturnQuantity(value: string, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, parsed));
}

export function getOrderItemName(item: OrderItem | undefined): string {
  if (!item) return "Order item";
  return [item.productName || "Unnamed product", item.variantLabel]
    .filter(Boolean)
    .join(" · ");
}
