// Owned by B5 (warranty): the line's warranty and "Make a claim", as markup for the account order page; nothing until B5 ships it.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** `extras.warranty` from the API (B5 gives it its shape). */
export type WarrantyLineExtra = unknown;

export function warrantyLineInfoMarkup(_line: OrderLine, _context: LineExtrasContext): string {
  return "";
}
