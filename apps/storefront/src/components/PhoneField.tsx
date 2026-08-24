import PhoneInput, { getCountries } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Country } from "react-phone-number-input";
import { FLAG_URL } from "@scalius/shared/phone-flags";
import {
  hasActivePhoneCountryPolicy,
  validateStorefrontPhone,
} from "@/lib/phone-country-policy";
import { readCheckoutFormDraft } from "@/lib/checkout/session-state";

interface PhoneFieldProps {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  defaultCountry?: string;
  helpText?: string;
  label?: string;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
}

export default function PhoneField({
  name,
  defaultValue,
  placeholder,
  required,
  defaultCountry = "BD",
  helpText,
  label,
  allowedCountries,
  allowedCountriesMode = "include",
}: PhoneFieldProps) {
  const inputId = `${name}-input`;
  const [value, setValue] = useState(
    () => {
      const initialValue = defaultValue || readCheckoutFormDraft()?.customerPhone || "";
      if (!initialValue) return "";
      const result = validateStorefrontPhone(
        initialValue,
        { countries: allowedCountries, mode: allowedCountriesMode },
        { required: false },
      );
      return result.ok ? result.value : "";
    },
  );
  const [error, setError] = useState("");
  const errorId = useId();
  const countryPolicy = useMemo(
    () => ({ countries: allowedCountries, mode: allowedCountriesMode }),
    [allowedCountries, allowedCountriesMode],
  );
  const hasActiveCountryPolicy = hasActivePhoneCountryPolicy(countryPolicy);

  // Compute the effective countries list based on mode
  const effectiveCountries = useMemo(() => {
    if (!allowedCountries || allowedCountries.length === 0) return undefined;
    if (allowedCountriesMode === "exclude") {
      const excluded = new Set(allowedCountries);
      return getCountries().filter((c) => !excluded.has(c));
    }
    return allowedCountries as Country[];
  }, [allowedCountries, allowedCountriesMode]);

  const effectiveDefaultCountry = useMemo(() => {
    if (effectiveCountries && effectiveCountries.length > 0) {
      return effectiveCountries[0] as Country;
    }
    if (hasActiveCountryPolicy) return undefined;
    return defaultCountry as Country;
  }, [effectiveCountries, defaultCountry, hasActiveCountryPolicy]);

  const validate = useCallback(() => {
    const result = validateStorefrontPhone(value, countryPolicy, { required });
    setError(result.ok ? "" : result.message || "Enter a valid phone number.");
    if (result.ok && result.value !== value) setValue(result.value);
    return result.ok;
  }, [countryPolicy, required, value]);

  useEffect(() => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (input) input.dataset.e164Value = value;
  }, [inputId, value]);

  // Listen for external pre-fill (customer login autofill dispatches this event)
  useEffect(() => {
    const handler = (e: Event) => {
      const phone = (e as CustomEvent<string>).detail;
      if (phone) setValue((current) => current || phone);
    };
    window.addEventListener("phone-prefill", handler);
    const draftPhone = readCheckoutFormDraft()?.customerPhone;
    if (draftPhone) setValue((current) => current || draftPhone);
    return () => window.removeEventListener("phone-prefill", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; message?: string }>).detail;
      if (detail?.name !== name) return;
      setError(detail.message || "Enter a valid phone number.");
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(`#${CSS.escape(name)}-field .PhoneInputInput`)?.focus();
      });
    };
    window.addEventListener("phone-validation-error", handler);
    return () => window.removeEventListener("phone-validation-error", handler);
  }, [name]);

  return (
    <div id={`${name}-field`}>
      {label && (
        <label
          htmlFor={inputId}
          className="mb-1 block text-sm font-medium text-foreground"
        >
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <PhoneInput
        id={inputId}
        name={name}
        international
        addInternationalOption={!hasActiveCountryPolicy}
        countryCallingCodeEditable={!hasActiveCountryPolicy}
        defaultCountry={effectiveDefaultCountry}
        countries={effectiveCountries}
        flagUrl={FLAG_URL}
        value={value}
        onChange={(v) => {
          setValue(v || "");
          setError("");
        }}
        onBlur={validate}
        required={required}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={placeholder || "Phone number"}
        className={`flex h-[46px] w-full rounded-lg border bg-muted px-3 text-base text-foreground shadow-sm transition-all md:h-9 ${error ? "border-destructive focus-within:border-destructive focus-within:ring-destructive/20" : "border-input focus-within:border-primary focus-within:ring-primary/20"} focus-within:bg-background focus-within:ring-1 [&_.PhoneInputInput]:h-full [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:text-base [&_.PhoneInputInput]:outline-none`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-destructive">
          {error}
        </p>
      ) : helpText ? (
        <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>
      ) : null}
    </div>
  );
}
