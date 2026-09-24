import * as React from "react";
import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from "@scalius/shared/customer-utils";
import { compactPhone, normalizeBdMobile, toLatinDigits } from "@scalius/shared/phone-input";
import { Input } from "@/components/ui/input";

/** The store's "Phone numbers accepted from" setting. */
export interface PhoneCountryPolicy {
  allowedCountries: readonly string[];
  allowedCountriesMode: "include" | "exclude";
}

/** A Bangladesh mobile as merchants read it (01XXXXXXXXX); anything else as typed, with Latin digits. */
export function normalizeAdminPhone(raw: string): string {
  const e164 = normalizeBdMobile(raw);
  return e164 ? `0${e164.slice(4)}` : toLatinDigits(raw).trim();
}

/**
 * Why a typed phone can't be saved, or null. A Bangladesh mobile in any
 * format, or a full international number (+country…) from a country the
 * store accepts. The server applies the same rule.
 */
export function adminPhoneProblem(
  raw: string,
  policy?: PhoneCountryPolicy,
): "phoneInvalid" | "phoneCountry" | null {
  if (!raw.trim()) return null;
  let country: string | undefined = "BD";
  if (!normalizeBdMobile(raw)) {
    const international = compactPhone(raw);
    if (!international.startsWith("+") || !isValidPhoneNumber(international)) return "phoneInvalid";
    country = parsePhoneNumberFromString(international)?.country;
  }
  if (!policy?.allowedCountries.length) return null;
  const listed = policy.allowedCountries.some((code) => code.toUpperCase() === country);
  return (policy.allowedCountriesMode === "exclude") === listed ? "phoneCountry" : null;
}

type AdminPhoneInputProps = Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value?: string | null;
  onChange: (value: string) => void;
};

/**
 * The dashboard's one phone field. Takes any spacing, dashes, +880/880/0 and
 * Bangla digits; on blur a Bangladesh mobile becomes 01XXXXXXXXX. Stored
 * +8801… values show the same way. Validation belongs to the form around it.
 */
export const AdminPhoneInput = React.forwardRef<HTMLInputElement, AdminPhoneInputProps>(
  function AdminPhoneInput({ value, onChange, onBlur, ...props }, ref) {
    const text = value ?? "";
    const storedMobile = text.startsWith("+") ? normalizeBdMobile(text) : null;
    return (
      <Input
        placeholder="01XXXXXXXXX"
        {...props}
        ref={ref}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={storedMobile ? `0${storedMobile.slice(4)}` : text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => {
          const normalized = normalizeAdminPhone(event.target.value);
          if (normalized !== text) onChange(normalized);
          onBlur?.(event);
        }}
      />
    );
  },
);
