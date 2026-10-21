import { isErasedText } from "@scalius/shared/customer-erasure";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import type { customersMessages } from "~/i18n/customers";

export type CustomerKind = "account" | "guest" | "merchant";

type CustomerMessageKey = keyof (typeof customersMessages)["en"];
type Translate = (key: CustomerMessageKey, vars?: Record<string, string | number>) => string;

export interface CustomerTitleInput {
  name: string;
  /** Null for a record without a phone (a digital or service buyer), keyed by its email. */
  phone: string | null;
  email?: string | null;
  kind: CustomerKind;
  latestOrderName?: string | null;
}

/**
 * The title every screen shows for a customer record, as Shopify's: the name
 * first, the phone (or email) under it. A guest record is keyed by phone and
 * has no name of its own, so it is named by the buyer on its latest order;
 * with no order name left it is titled by its phone (or email) and says
 * "Guest orders". Accounts and customers the merchant created keep their own
 * name. `detailIsPhone` says the detail line is a phone number, to set in the
 * number style. A customer whose personal data was erased reads "Erased
 * customer", with nothing under it.
 */
export function customerTitle(
  customer: CustomerTitleInput,
  t: Translate,
): { title: string; detail: string | null; detailIsPhone: boolean } {
  if (isErasedText(customer.name)) return { title: t("erasedCustomer"), detail: null, detailIsPhone: false };
  const phone = customer.phone ? formatPhoneForDisplay(customer.phone, getStoreRegion()) : null;
  const email = customer.email?.trim() || null;
  if (customer.kind === "guest") {
    // An erased order name is no one's name: the record falls back to its contact.
    const latest = isErasedText(customer.latestOrderName) ? null : customer.latestOrderName?.trim() || null;
    const contact = phone ?? email;
    if (latest) return { title: latest, detail: contact, detailIsPhone: phone !== null };
    if (contact) return { title: contact, detail: t("guestOrders"), detailIsPhone: false };
  }
  return { title: customer.name.trim() || t("unnamed"), detail: phone ?? email, detailIsPhone: phone !== null };
}
