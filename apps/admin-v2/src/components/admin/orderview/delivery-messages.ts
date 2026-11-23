// What each order line says about its delivery message (`item.extras.message`,
// composed by the API, never the text), narrowed from the order's untyped extras.
import type { Order, OrderItem } from "./types";

export interface LineMessage {
  messageId: string;
  hasLink: boolean;
  /** ISO timestamp. */
  updatedAt: string;
  /** Sent back as `expectedRevision` when the message is written. */
  revision: number;
  /** The line the message is stored on: a split kit pair shares one. */
  orderItemId: string;
}

export interface MessageLine {
  item: Pick<OrderItem, "id" | "productName" | "variantLabel">;
  message: LineMessage | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

export function lineMessageOf(item: Pick<OrderItem, "extras">): LineMessage | null {
  const row = record(item.extras?.message);
  if (
    !row
    || typeof row.messageId !== "string"
    || typeof row.updatedAt !== "string"
    || typeof row.revision !== "number"
    || typeof row.orderItemId !== "string"
  ) return null;
  return { messageId: row.messageId, hasLink: row.hasLink === true, updatedAt: row.updatedAt, revision: row.revision, orderItemId: row.orderItemId };
}

/**
 * The lines staff can write a delivery message for: digital lines, and any
 * line that already has one. A kit split into two lines shares one message;
 * it is listed once, on the line that holds it.
 */
export function messageLinesOf(order: Pick<Order, "items">): MessageLine[] {
  const ids = new Set(order.items.map((item) => item.id));
  return order.items.flatMap((item) => {
    const message = lineMessageOf(item);
    if (message && message.orderItemId !== item.id && ids.has(message.orderItemId)) return [];
    return message || item.fulfillmentType === "digital" ? [{ item, message }] : [];
  });
}
