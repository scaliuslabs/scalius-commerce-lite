import { isEmailAddress } from "@scalius/shared/text-scan";
import {
  DEFAULT_CUSTOMER_IDENTITY,
  channelRequestMethod,
  isCustomerAuthOtpChannel,
  newAccountPhoneNeed,
  type CustomerAuthOtpChannel,
  type CustomerAuthRequestMethod,
  type CustomerIdentitySettings,
  type FieldNeed,
} from "@scalius/shared/customer-auth-policy";
import type { PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import { isBangladeshNumber, normalizeBdMobile } from "@scalius/shared/phone-input";
import { validateStorefrontPhone } from "@/lib/phone-country-policy";
import { SIGN_IN_EN, type SignInCheckCopy } from "@/lib/sign-in-copy";

export type { FieldNeed };

export interface CustomerAuthRequestOption {
  channel: CustomerAuthOtpChannel;
  method: CustomerAuthRequestMethod;
}

export interface CustomerAuthUiModel {
  otpChannel: CustomerAuthOtpChannel;
  requestMethod: CustomerAuthRequestMethod;
  requestOptions: CustomerAuthRequestOption[];
  showMethodSwitcher: boolean;
  /** False when no chosen channel can send right now: sign-in says so and sends nothing. */
  available: boolean;
  /** False when the store sends no phone codes: sign-in is by email only. */
  phoneSignIn: boolean;
  /**
   * What a new buyer adds after proving this email/phone. The proven
   * contact itself is never asked again; phone is always required.
   */
  newAccount: { phone: FieldNeed; email: FieldNeed };
}

export function isValidEmail(value: string): boolean {
  return isEmailAddress(value.trim());
}

/**
 * One sign-in flow. Customer accounts decides the channels (only those that
 * can send are published) and which extra fields a new account gives.
 */
export function resolveCustomerAuthUi(
  identityInput: CustomerIdentitySettings | null | undefined,
  otpChannelInput?: CustomerAuthOtpChannel,
): CustomerAuthUiModel {
  const identity = identityInput ?? DEFAULT_CUSTOMER_IDENTITY;
  const requestOptions = identity.channels.map((channel) => ({ channel, method: channelRequestMethod(channel) }));
  const otpChannel = isCustomerAuthOtpChannel(otpChannelInput) && identity.channels.includes(otpChannelInput)
    ? otpChannelInput
    : identity.channels[0] ?? "email";
  const requestMethod = channelRequestMethod(otpChannel);
  return {
    otpChannel,
    requestMethod,
    requestOptions,
    showMethodSwitcher: requestOptions.length > 1,
    available: requestOptions.length > 0,
    phoneSignIn: requestOptions.some((option) => option.method === "phone"),
    newAccount: {
      // An email sign-up skips the phone only with the store's opt-in (orders still ask when they need it).
      phone: requestMethod === "phone" ? "hidden" : newAccountPhoneNeed(identity, requestMethod),
      email: requestMethod === "email" ? "hidden" : identity.email,
    },
  };
}

export type ContactCheck = { ok: true; value: string } | { ok: false; message: string };

/**
 * Accepts Bangla digits and any spacing; returns what the API expects.
 * `words` are the page's (lib/sign-in-copy.ts), `example` a number in its digits.
 */
export function checkPhone(
  value: string,
  policy?: PhoneCountryPolicy,
  words: SignInCheckCopy = SIGN_IN_EN.check,
  example = "01712345678",
): ContactCheck {
  if (!value.trim()) return { ok: false, message: words.enterPhone };
  const bd = normalizeBdMobile(value);
  if (bd) return { ok: true, value: bd };
  if (isBangladeshNumber(value)) return { ok: false, message: words.bangladeshMobile };
  const result = validateStorefrontPhone(value, policy);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, message: words.invalidPhone(example) };
}

export function checkEmail(value: string, words: SignInCheckCopy = SIGN_IN_EN.check): ContactCheck {
  if (!value.trim()) return { ok: false, message: words.enterEmail };
  return isValidEmail(value)
    ? { ok: true, value: value.trim().toLowerCase() }
    : { ok: false, message: words.invalidEmail };
}

export function checkContact(
  method: CustomerAuthRequestMethod,
  value: string,
  policy?: PhoneCountryPolicy,
  words: SignInCheckCopy = SIGN_IN_EN.check,
  example?: string,
): ContactCheck {
  return method === "email" ? checkEmail(value, words) : checkPhone(value, policy, words, example);
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
  words: SignInCheckCopy = SIGN_IN_EN.check,
  example?: string,
): NewAccountCheck {
  const errors: Array<{ field: NewAccountField; message: string }> = [];
  const name = input.name.trim();
  if (!name) errors.push({ field: "name", message: words.enterName });
  const account: { name: string; phone?: string; email?: string } = { name };
  if (ui.newAccount.phone !== "hidden" && (ui.newAccount.phone === "required" || input.phone.trim())) {
    const phone = checkPhone(input.phone, policy, words, example);
    if (phone.ok) account.phone = phone.value;
    else errors.push({ field: "phone", message: phone.message });
  }
  if (ui.newAccount.email !== "hidden" && (ui.newAccount.email === "required" || input.email.trim())) {
    const email = checkEmail(input.email, words);
    if (email.ok) account.email = email.value;
    else errors.push({ field: "email", message: email.message });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, account };
}
