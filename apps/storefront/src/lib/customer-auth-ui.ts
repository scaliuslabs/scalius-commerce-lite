import {
  getCustomerAuthRequestOptions,
  getDefaultCustomerAuthOtpChannel,
  isContactFieldRequiredForAuthChannel,
  isContactFieldVisibleForAuthChannel,
  isCustomerAuthOtpChannel,
  normalizeCustomerAuthPolicy,
  type CustomerAuthOtpChannel,
  type CustomerAuthPolicyConfig,
  type CustomerAuthRequestMethod,
  type CustomerAuthRequestOption,
} from "@scalius/shared/customer-auth-policy";
import type { PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import { normalizeBdMobile } from "@scalius/shared/phone-input";
import { validateStorefrontPhone } from "@/lib/phone-country-policy";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldNeed = "required" | "optional" | "hidden";

export interface CustomerAuthUiModel {
  policy: CustomerAuthPolicyConfig;
  otpChannel: CustomerAuthOtpChannel;
  requestMethod: CustomerAuthRequestMethod;
  requestOptions: CustomerAuthRequestOption[];
  currentOption: CustomerAuthRequestOption;
  showMethodSwitcher: boolean;
  /**
   * What a new buyer adds after proving this email/phone. The proven
   * contact itself is never asked again.
   */
  newAccount: { phone: FieldNeed; email: FieldNeed };
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** One sign-in flow; the store's policy only decides channels and extra fields. */
export function resolveCustomerAuthUi(
  authPolicyInput: unknown,
  otpChannelInput?: CustomerAuthOtpChannel,
): CustomerAuthUiModel {
  const policy = normalizeCustomerAuthPolicy(authPolicyInput, authPolicyInput);
  const requestOptions = getCustomerAuthRequestOptions(policy);
  const otpChannel = isCustomerAuthOtpChannel(otpChannelInput) && policy.otpChannels.includes(otpChannelInput)
    ? otpChannelInput
    : getDefaultCustomerAuthOtpChannel(policy);
  const currentOption = requestOptions.find((option) => option.channel === otpChannel) ?? requestOptions[0]!;
  const need = (field: "email" | "phone"): FieldNeed => {
    if (currentOption.destinationField === field) return "hidden";
    if (isContactFieldRequiredForAuthChannel(policy, otpChannel, field)) return "required";
    return isContactFieldVisibleForAuthChannel(policy, otpChannel, field) ? "optional" : "hidden";
  };

  return {
    policy,
    otpChannel,
    requestMethod: currentOption.method,
    requestOptions,
    currentOption,
    showMethodSwitcher: requestOptions.length > 1,
    newAccount: { phone: need("phone"), email: need("email") },
  };
}

export type ContactCheck = { ok: true; value: string } | { ok: false; message: string };

/** Accepts Bangla digits and any spacing; returns what the API expects. */
export function checkPhone(value: string, policy?: PhoneCountryPolicy): ContactCheck {
  if (!value.trim()) return { ok: false, message: "Enter your phone number." };
  const bd = normalizeBdMobile(value);
  if (bd) return { ok: true, value: bd };
  const result = validateStorefrontPhone(value, policy);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, message: "Enter a valid mobile number, like 01712345678." };
}

export function checkEmail(value: string): ContactCheck {
  if (!value.trim()) return { ok: false, message: "Enter your email address." };
  return isValidEmail(value)
    ? { ok: true, value: value.trim().toLowerCase() }
    : { ok: false, message: "Enter a valid email address, like name@example.com." };
}

export function checkContact(
  method: CustomerAuthRequestMethod,
  value: string,
  policy?: PhoneCountryPolicy,
): ContactCheck {
  return method === "email" ? checkEmail(value) : checkPhone(value, policy);
}

export interface NewAccountInput {
  name: string;
  phone: string;
  email: string;
}

export type NewAccountField = "name" | "phone" | "email";

export type NewAccountCheck =
  | { ok: true; account: { name: string; phone?: string; email?: string } }
  | { ok: false; errors: Array<{ field: NewAccountField; message: string }> };

/** Checks every field at once, in form order, so each error shows under its field. */
export function checkNewAccount(
  ui: CustomerAuthUiModel,
  input: NewAccountInput,
  policy?: PhoneCountryPolicy,
): NewAccountCheck {
  const errors: Array<{ field: NewAccountField; message: string }> = [];
  const name = input.name.trim();
  if (!name) errors.push({ field: "name", message: "Enter your name." });
  const account: { name: string; phone?: string; email?: string } = { name };
  if (ui.newAccount.phone !== "hidden" && (ui.newAccount.phone === "required" || input.phone.trim())) {
    const phone = checkPhone(input.phone, policy);
    if (phone.ok) account.phone = phone.value;
    else errors.push({ field: "phone", message: phone.message });
  }
  if (ui.newAccount.email !== "hidden" && (ui.newAccount.email === "required" || input.email.trim())) {
    const email = checkEmail(input.email);
    if (email.ok) account.email = email.value;
    else errors.push({ field: "email", message: email.message });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, account };
}

/** "2:00", "0:45": the honest wait shown next to a disabled button. */
export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
