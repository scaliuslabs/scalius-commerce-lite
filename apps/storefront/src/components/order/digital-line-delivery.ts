// Owned by B3 (digital goods): the line's downloads and licence keys, as markup for the account order page; nothing until B3 ships it.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** `extras.downloads` from the API (B3 gives it its shape). */
export type DigitalDownloadsExtra = unknown;
/** `extras.licenceKeys` from the API (B3 gives it its shape). */
export type LicenceKeysExtra = unknown;

export function digitalLineDeliveryMarkup(_line: OrderLine, _context: LineExtrasContext): string {
  return "";
}
