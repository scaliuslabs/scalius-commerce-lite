// Owned by B2 (reviews storefront): the line's review form or the buyer's review, as markup for the account order page; nothing until B2 ships it.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** `extras.review` from the API (B2 gives it its shape). */
export type ReviewLineExtra = unknown;

export function reviewLineActionMarkup(_line: OrderLine, _context: LineExtrasContext): string {
  return "";
}
