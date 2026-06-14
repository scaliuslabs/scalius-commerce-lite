import PhoneInput, { getCountries } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { useState, useEffect, useMemo } from "react";
import type { Country } from "react-phone-number-input";
import { FLAG_URL } from "@scalius/shared/phone-flags";

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
  const [value, setValue] = useState(defaultValue || "");

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
    return defaultCountry as Country;
  }, [effectiveCountries, defaultCountry]);

  // Sync hidden input whenever value changes so DOM reads always see current value
  useEffect(() => {
    const hidden = document.getElementById(name) as HTMLInputElement | null;
    if (hidden) hidden.value = value;
  }, [value, name]);

  // Listen for external pre-fill (customer login autofill dispatches this event)
  useEffect(() => {
    const handler = (e: Event) => {
      const phone = (e as CustomEvent<string>).detail;
      if (phone) setValue(phone);
    };
    window.addEventListener("phone-prefill", handler);
    return () => window.removeEventListener("phone-prefill", handler);
  }, []);

  return (
    <div>
      {label && (
        <label
          htmlFor={name}
          className="mb-1 block text-xs font-semibold text-foreground uppercase tracking-wide"
        >
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <input type="hidden" id={name} name={name} value={value} />
      <PhoneInput
        international
        defaultCountry={effectiveDefaultCountry}
        countries={effectiveCountries}
        flagUrl={FLAG_URL}
        value={value}
        onChange={(v) => setValue(v || "")}
        placeholder={placeholder || "Phone number"}
        className="flex h-9 w-full rounded-lg border border-input bg-muted px-3 py-1 text-sm text-foreground shadow-sm transition-all focus-within:bg-background focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:outline-none [&_.PhoneInputInput]:text-sm [&_.PhoneInputInput]:h-full"
      />
      {helpText && (
        <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>
      )}
    </div>
  );
}
