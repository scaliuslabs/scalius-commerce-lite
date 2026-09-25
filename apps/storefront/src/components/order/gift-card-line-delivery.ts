// Owned by B4 (gift cards): the gift cards the line issued, as markup for the account order page; nothing until B4 ships it.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** `extras.giftCards` from the API (B4 gives it its shape). */
export type GiftCardsExtra = unknown;

export function giftCardLineDeliveryMarkup(_line: OrderLine, _context: LineExtrasContext): string {
  return "";
}
