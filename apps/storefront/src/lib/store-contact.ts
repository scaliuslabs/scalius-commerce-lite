// "Contact the store: 01711-000000 · WhatsApp · shop@example.com" from Business
// settings. Every page that can dead-end a buyer (no code channel, a declined
// request) shows these links, or nothing when the store has none.

import { pagePhone } from "@/lib/checkout-text";
import { isEmailAddress } from "@scalius/shared/text-scan";
import type { StorefrontBusinessInfo } from "./commerce-structured-data";
import { compactPhone, normalizeBdMobile } from "@scalius/shared/phone-input";

export interface StoreContactLink {
  kind: "phone" | "whatsapp" | "email";
  href: string;
  label: string;
}

/** Call, WhatsApp (Bangladesh mobile numbers only) and email links, in that order. */
export function storeContactLinks(
  business: Pick<StorefrontBusinessInfo, "phone" | "email"> | null | undefined,
): StoreContactLink[] {
  const links: StoreContactLink[] = [];
  const phone = business?.phone?.trim() || "";
  const mobile = phone ? normalizeBdMobile(phone) : null;
  // A landline or foreign number is dialled as written; only a mobile gets +880.
  const dial = mobile ?? compactPhone(phone);
  if (/^\+?\d{6,15}$/.test(dial)) links.push({ kind: "phone", href: `tel:${dial}`, label: pagePhone(phone) });
  if (mobile) links.push({ kind: "whatsapp", href: `https://wa.me/${mobile.slice(1)}`, label: "WhatsApp" });
  const email = business?.email?.trim() || "";
  if (isEmailAddress(email, { forbiddenCharacters: '<>"' })) links.push({ kind: "email", href: `mailto:${email}`, label: email });
  return links;
}
