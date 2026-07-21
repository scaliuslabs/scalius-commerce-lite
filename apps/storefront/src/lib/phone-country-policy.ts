import {
  normalizePhoneCountryPolicy,
  validateAndFormatPhone,
  type PhoneCountryPolicy,
} from "@scalius/shared/customer-utils";

export interface StorefrontPhoneValidationResult {
  ok: boolean;
  value: string;
  message?: string;
}

export function hasActivePhoneCountryPolicy(
  policy: PhoneCountryPolicy | undefined,
): boolean {
  return normalizePhoneCountryPolicy(policy).countries.length > 0;
}

export function validateStorefrontPhone(
  input: string,
  policy: PhoneCountryPolicy | undefined,
  options: { required?: boolean } = {},
): StorefrontPhoneValidationResult {
  const value = input.trim();
  if (!value) {
    return options.required === false
      ? { ok: true, value: "" }
      : { ok: false, value: "", message: "Enter your phone number." };
  }

  try {
    return {
      ok: true,
      value: validateAndFormatPhone(value, policy),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      ok: false,
      value,
      message: message.includes("not accepted")
        ? "This store does not accept phone numbers from that country."
        : "Enter a valid phone number.",
    };
  }
}
