// The contacts an order keeps, decided by Settings → Customer accounts (the
// customer_auth document, read with the checkout authority). Phone is always
// required and validated elsewhere; this owns email and WhatsApp.
import { ValidationError } from "@scalius/core/errors";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";

export type CheckoutContactFieldSettings = Pick<CustomerIdentitySettings, "email" | "whatsapp">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email: required → must be present; optional → kept when given; hidden →
 * dropped. WhatsApp: kept only in "separate" mode, and only when it differs
 * from the phone (null means "same as phone"). Without settings (internal
 * callers and tests) email passes through and no WhatsApp number is kept.
 */
export function resolveCheckoutContact(
  settings: CheckoutContactFieldSettings | undefined,
  input: { customerPhone: string; customerEmail?: string | null; customerWhatsapp?: string | null },
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
