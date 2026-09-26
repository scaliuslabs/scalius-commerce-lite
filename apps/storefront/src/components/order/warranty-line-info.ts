// Owned by B5 (warranty): the line's warranty records, as markup for the
// browser-rendered account order page (the receipt renders the same facts,
// with the claim form in place, through WarrantyLineInfo.astro). "Make a claim"
// opens the claim form on Account › Warranties; a claim's thread is in the Inbox.
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import {
  accountClaimFormHref,
  lineWarrantyMarkup,
  pickWarrantyCopy,
  readLineWarranties,
  type WarrantyAccess,
} from "@/lib/account-warranties";
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** `extras.warranty` from the API: one record per handed-over fulfilment line (read with `readLineWarranties`). */
export type WarrantyLineExtra = unknown;

export function warrantyLineInfoMarkup(line: OrderLine, context: LineExtrasContext): string {
  const records = readLineWarranties(line.extras?.warranty);
  if (records.length === 0) return "";
  const copy = pickWarrantyCopy(null, ENGLISH_CHECKOUT_LANGUAGE_DATA);
  const access: WarrantyAccess = context.access === "account" ? { kind: "account" } : { kind: "receipt", orderId: context.orderId };
  const now = Date.now();
  return records.map((record) => lineWarrantyMarkup(record, {
    copy,
    access,
    now,
    claimHref: access.kind === "account" ? accountClaimFormHref(record.warrantyId) : null,
  })).join("");
}
