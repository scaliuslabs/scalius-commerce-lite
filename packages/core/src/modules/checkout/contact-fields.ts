// The contacts an order keeps, decided by Settings → Customer accounts (the
// customer_auth document, read with the checkout authority). The phone's
// format is validated at the edge; whether the order needs one is the shared
// contact rule (`orderContactNeeds`). This owns email, WhatsApp and that rule.
import { ValidationError } from "@scalius/core/errors";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import {
  orderContactNeeds,
  orderPaymentKind,
  type CustomerIdentitySettings,
} from "@scalius/shared/customer-auth-policy";
import type { FulfillmentKind } from "@scalius/shared/fulfilment";

export type CheckoutContactFieldSettings = Pick<CustomerIdentitySettings, "email" | "whatsapp"> &
  Partial<Pick<CustomerIdentitySettings, "phoneOptionalForDigital">>;

/** `details.reason` when an order needs a phone and has none. */
export const PHONE_REQUIRED_REASON = "phone_required";

/**
 * Applies the shared contact rule to one order: a phone unless the rule lets
 * it go, and then an email. Without settings (internal callers and tests)
 * the phone is required.
 */
export function assertOrderContact(
  settings: CheckoutContactFieldSettings | undefined,
  order: {
    customerPhone: string | null;
    customerEmail: string | null;
    lines: readonly { fulfillmentKind: FulfillmentKind; isGiftCard?: boolean | null }[];
    paymentMethod: string;
    /** The store takes an advance deposit for this order (partial payment, no gift cards). */
    depositPlan: boolean;
    countryCode: string | null | undefined;
  },
): void {
  const needs = orderContactNeeds(
    { email: settings?.email ?? "optional", phoneOptionalForDigital: settings?.phoneOptionalForDigital === true },
    {
      lines: order.lines.map((line) => ({ fulfillmentKind: line.fulfillmentKind, isGiftCard: line.isGiftCard === true })),
      payment: orderPaymentKind(order.paymentMethod, { depositPlan: order.depositPlan }),
      countryCode: order.countryCode,
    },
  );
  if (order.customerPhone) return;
  if (needs.phone === "required") {
    throw new ValidationError("Enter your phone number.", {
      field: "customerPhone",
      reason: PHONE_REQUIRED_REASON,
      phoneRequiredBecause: needs.phoneReason,
    });
  }
  if (!order.customerEmail) {
    throw new ValidationError("Enter your email address.", { field: "customerEmail" });
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email: required → must be present; optional → kept when given; hidden →
 * dropped. WhatsApp: kept only in "separate" mode, and only when it differs
 * from the phone (null means "same as phone"). Without settings (internal
 * callers and tests) email passes through and no WhatsApp number is kept.
 */
export function resolveCheckoutContact(
  settings: CheckoutContactFieldSettings | undefined,
  input: { customerPhone: string | null; customerEmail?: string | null; customerWhatsapp?: string | null },
): { customerEmail: string | null; customerWhatsapp: string | null } {
  const email = input.customerEmail?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email) && settings?.email !== "hidden") {
    throw new ValidationError("Enter a valid email address.", { field: "customerEmail" });
  }
  const mode = settings?.email ?? "optional";
  if (mode === "required" && !email) {
    throw new ValidationError("Enter your email address.", { field: "customerEmail" });
  }
  const customerEmail = mode === "hidden" ? null : email;

  const rawWhatsapp = input.customerWhatsapp?.trim();
  if (settings?.whatsapp !== "separate" || !rawWhatsapp) return { customerEmail, customerWhatsapp: null };
  let whatsapp: string;
  try {
    whatsapp = validateAndFormatPhone(rawWhatsapp);
  } catch {
    throw new ValidationError("Enter a valid WhatsApp number.", { field: "customerWhatsapp" });
  }
  return { customerEmail, customerWhatsapp: whatsapp === input.customerPhone ? null : whatsapp };
}
