/**
 * "Edit" on a cart line with buyer inputs: the cart hands the line to its
 * product page through session storage (never the URL, since the inputs are
 * buyer content), the product page fills the form from it, and "Update cart"
 * replaces the line under its new key (`replaceCartLine`).
 */
import type { CartLineProperty } from "@/store/cart";

const STORAGE_KEY = "scalius_cart_line_edit";
/** An edit left unfinished this long ago no longer applies. */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface CartLineEdit {
  lineKey: string;
  productId: string;
  variantId: string;
  quantity: number;
  properties: Array<Pick<CartLineProperty, "key" | "value">>;
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function writeCartLineEdit(edit: Omit<CartLineEdit, "createdAt">): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...edit, createdAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** The pending edit of a line of this product, or null. */
export function readCartLineEdit(productId: string, now = Date.now()): CartLineEdit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.productId !== productId ||
    typeof parsed.lineKey !== "string" ||
    typeof parsed.variantId !== "string" ||
    typeof parsed.quantity !== "number" ||
    typeof parsed.createdAt !== "number" ||
    now - parsed.createdAt > MAX_AGE_MS ||
    !Array.isArray(parsed.properties)
  ) {
    return null;
  }
  const properties = parsed.properties.flatMap((entry) =>
    isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string"
      ? [{ key: entry.key, value: entry.value }]
      : []);
  return {
    lineKey: parsed.lineKey,
    productId,
    variantId: parsed.variantId,
    quantity: Math.min(99, Math.max(1, Math.floor(parsed.quantity))),
    properties,
    createdAt: parsed.createdAt,
  };
}

export function clearCartLineEdit(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
