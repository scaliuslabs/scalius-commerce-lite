// A cart line's purchase option: an app's way to buy it (a subscription, a
// rental; manifest `checkout.purchaseOptions`). The id is part of the line's
// identity (the same SKU one-time and under an option are two lines) and
// travels in request bodies as the line's `purchaseOption`; the title is
// what the buyer chose, for display. The app prices the line at checkout.
import { isPurchaseOptionId } from "@scalius/shared/plugins/ids";

export type CartLinePurchaseOption = {
  /** `<app id>.<key>`. */
  id: string;
  /** "Subscribe and save" (display only). */
  title: string;
};

/** The longest title kept (the manifest's limit). */
const MAX_PURCHASE_OPTION_TITLE_LENGTH = 80;

/**
 * A stored or answered option: undefined for none, null when it is malformed
 * (a line whose identity can't be trusted is dropped, never re-keyed).
 */
export function normalizeCartLinePurchaseOption(value: unknown): CartLinePurchaseOption | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  if (!isPurchaseOptionId(id)) return null;
  const text = typeof title === "string" ? Array.from(title.normalize("NFC").trim()).slice(0, MAX_PURCHASE_OPTION_TITLE_LENGTH).join("") : "";
  return { id, title: text || id };
}

/** The id a line sends (`purchaseOption`), from a cart line's option or an id; undefined for none or a malformed one. */
export function cartLinePurchaseOptionId(value: unknown): string | undefined {
  if (isPurchaseOptionId(value)) return value;
  if (typeof value === "object" && value !== null && isPurchaseOptionId((value as { id?: unknown }).id)) {
    return (value as { id: string }).id;
  }
  return undefined;
}
