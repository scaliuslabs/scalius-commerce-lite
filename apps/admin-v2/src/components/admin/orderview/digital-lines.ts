// What each order line delivered digitally (`item.extras.downloads` and
// `item.extras.licenceKeys`, composed by the API), narrowed from the
// order's untyped extras.
import type { Order, OrderItem } from "./types";

export interface LineDownload {
  entitlementId: string;
  displayName: string;
  downloadCount: number;
  /** null = unlimited. */
  downloadLimit: number | null;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  revoked: boolean;
}

export interface LineKey {
  keyId: string;
  last4: string;
}

export interface DigitalLine {
  item: Pick<OrderItem, "id" | "productId" | "productName" | "variantLabel">;
  downloads: LineDownload[];
  keys: LineKey[];
  /** Paid, but auto-delivery hasn't handed it over (an empty key pool, most often). */
  undelivered: boolean;
}

export interface DigitalDelivery {
  lines: DigitalLine[];
  /** Cancelled, refunded or returned: the buyer's access stopped. */
  accessEnded: boolean;
}

const ENDED_STATUSES = new Set(["cancelled", "refunded", "returned"]);
const SETTLED_PAYMENTS = new Set(["paid", "partially_refunded"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

function download(value: unknown): LineDownload | null {
  const row = record(value);
  if (!row || typeof row.entitlementId !== "string" || typeof row.displayName !== "string" || typeof row.downloadCount !== "number") return null;
  return {
    entitlementId: row.entitlementId,
    displayName: row.displayName,
    downloadCount: row.downloadCount,
    downloadLimit: typeof row.downloadLimit === "number" ? row.downloadLimit : null,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    revoked: row.revoked === true,
  };
}

function key(value: unknown): LineKey | null {
  const row = record(value);
  return row && typeof row.keyId === "string" && typeof row.last4 === "string" ? { keyId: row.keyId, last4: row.last4 } : null;
}

const list = <T>(value: unknown, read: (entry: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.map(read).filter((entry): entry is T => entry !== null) : [];

/**
 * The lines that delivered files or licence keys, plus digital lines a settled
 * order still owes (auto-delivery retries them; the merchant should see why).
 */
export function digitalDeliveryOf(order: Pick<Order, "items" | "status" | "paymentStatus">): DigitalDelivery {
  const accessEnded = ENDED_STATUSES.has(order.status.toLowerCase());
  const owed = !accessEnded && SETTLED_PAYMENTS.has((order.paymentStatus ?? "").toLowerCase());
  const lines = order.items.flatMap((item) => {
    const downloads = list(item.extras?.downloads, download);
    const keys = list(item.extras?.licenceKeys, key);
    const undelivered = owed && item.fulfillmentType === "digital" && item.fulfilledQuantity < item.quantity;
    return downloads.length > 0 || keys.length > 0 || undelivered ? [{ item, downloads, keys, undelivered }] : [];
  });
  return { lines, accessEnded };
}
