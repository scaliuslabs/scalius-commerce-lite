import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import type { customersMessages } from "~/i18n/customers";

export type CustomerKind = "account" | "guest" | "merchant";

type CustomerMessageKey = keyof (typeof customersMessages)["en"];
type Translate = (key: CustomerMessageKey, vars?: Record<string, string | number>) => string;

export interface CustomerTitleInput {
  name: string;
  phone: string;
  kind: CustomerKind;
  latestOrderName?: string | null;
}

/**
 * The title every screen shows for a customer record. Checkout files guest
 * orders under a record keyed by phone, and different people can share a
 * phone, so a guest record is named by its phone, never by one buyer: the
 * latest order's name is only secondary text. Accounts and customers the
 * merchant created keep their own name.
 */
export function customerTitle(customer: CustomerTitleInput, t: Translate): { title: string; detail: string | null } {
  if (customer.kind === "guest") {
    const latest = customer.latestOrderName?.trim();
    return { title: t("guestTitle", { phone: formatPhoneForDisplay(customer.phone) }), detail: latest || null };
  }
  return { title: customer.name.trim() || t("unnamed"), detail: null };
}
