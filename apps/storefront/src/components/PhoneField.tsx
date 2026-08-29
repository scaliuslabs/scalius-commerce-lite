import PhoneInput, { getCountries } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Country } from "react-phone-number-input";
import englishPhoneLabels from "react-phone-number-input/locale/en.json";
import { FLAG_URL } from "@scalius/shared/phone-flags";
import {
  hasActivePhoneCountryPolicy,
  validateStorefrontPhone,
} from "@/lib/phone-country-policy";
import {
  readCheckoutFormDraft,
  syncCheckoutTransferSession,
  writeCheckoutFormDraft,
} from "@/lib/checkout/session-state";

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
  requiredMessage?: string;
  invalidMessage?: string;
  countryNotAcceptedMessage?: string;
  countrySelectLabel?: string;
  languageCode?: string;
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
  requiredMessage = "Enter your phone number.",
  invalidMessage = "Enter a valid phone number.",
  countryNotAcceptedMessage = "This store does not accept phone numbers from that country.",
  countrySelectLabel = "Phone number country",
  languageCode = "en",
}: PhoneFieldProps) {
  const inputId = `${name}-input`;
  const countryPolicy = useMemo(
    () => ({ countries: allowedCountries, mode: allowedCountriesMode }),
    [allowedCountries, allowedCountriesMode],
  );
  const normalizePhone = useCallback(
    (phone: string | undefined) => {
      if (!phone) return "";
      const result = validateStorefrontPhone(phone, countryPolicy, {
        required: false,
      });
      return result.ok ? result.value : "";
    },
    [countryPolicy],
  );
  const [value, setValue] = useState(() => {
    const draft = readCheckoutFormDraft();
    const initialValue =
      draft && Object.prototype.hasOwnProperty.call(draft, "customerPhone")
        ? draft.customerPhone
        : defaultValue;
    return normalizePhone(initialValue);
  });
  const [error, setError] = useState("");
  const errorId = useId();
  const buyerHasEdited = useRef(false);
  const canonicalValue = normalizePhone(value);
  const hasActiveCountryPolicy = hasActivePhoneCountryPolicy(countryPolicy);

  const persistCanonicalValue = useCallback((phone: string) => {
    const draft = readCheckoutFormDraft();
    writeCheckoutFormDraft({
      ...(draft ?? {}),
      customerPhone: phone,
    });
    syncCheckoutTransferSession({ customerPhone: phone });
  }, []);

  // Compute the effective countries list based on mode
  const effectiveCountries = useMemo(() => {
    if (!allowedCountries || allowedCountries.length === 0) return undefined;
    if (allowedCountriesMode === "exclude") {
      const excluded = new Set(allowedCountries);
      return getCountries().filter((c) => !excluded.has(c));
    }
    return allowedCountries as Country[];
  }, [allowedCountries, allowedCountriesMode]);
  const phoneLabels = useMemo(() => {
    let displayNames: Intl.DisplayNames | null = null;
    try {
      displayNames = new Intl.DisplayNames([languageCode], { type: "region" });
    } catch {
      displayNames = null;
    }
    const localizedCountries = Object.fromEntries(
      getCountries().map((country) => [
        country,
        displayNames?.of(country) || englishPhoneLabels[country],
      ]),
    );
    return {
      ...englishPhoneLabels,
      ...localizedCountries,
      country: countrySelectLabel,
      phone: label || placeholder || englishPhoneLabels.phone,
    };
  }, [countrySelectLabel, label, languageCode, placeholder]);

  const effectiveDefaultCountry = useMemo(() => {
    if (effectiveCountries && effectiveCountries.length > 0) {
      return effectiveCountries[0] as Country;
    }
    if (hasActiveCountryPolicy) return undefined;
    return defaultCountry as Country;
  }, [effectiveCountries, defaultCountry, hasActiveCountryPolicy]);

  const validate = useCallback(() => {
    const result = validateStorefrontPhone(value, countryPolicy, { required });
    const localizedError = !result.message
      ? invalidMessage
      : result.message.includes("does not accept")
        ? countryNotAcceptedMessage
        : result.message.includes("your phone number")
          ? requiredMessage
          : invalidMessage;
    setError(result.ok ? "" : localizedError);
    if (result.ok) {
      if (result.value !== value) setValue(result.value);
      persistCanonicalValue(result.value);
    }
    return result.ok;
  }, [countryNotAcceptedMessage, countryPolicy, invalidMessage, persistCanonicalValue, required, requiredMessage, value]);

  // Listen for external pre-fill (customer login autofill dispatches this event)
  useEffect(() => {
    const handler = (e: Event) => {
      const phone = (e as CustomEvent<string>).detail;
      if (buyerHasEdited.current) return;
      const draft = readCheckoutFormDraft();
      const draftOwnsPhone = Boolean(
        draft && Object.prototype.hasOwnProperty.call(draft, "customerPhone"),
      );
      const preferredPhone = draftOwnsPhone ? draft?.customerPhone : phone;
      setValue(normalizePhone(preferredPhone));
    };
    window.addEventListener("phone-prefill", handler);
    return () => window.removeEventListener("phone-prefill", handler);
  }, [normalizePhone]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; message?: string }>)
        .detail;
      if (detail?.name !== name) return;
      setError(detail.message || invalidMessage);
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLInputElement>(
            `#${CSS.escape(name)}-field .PhoneInputInput`,
          )
          ?.focus();
      });
    };
    window.addEventListener("phone-validation-error", handler);
    return () => window.removeEventListener("phone-validation-error", handler);
  }, [invalidMessage, name]);

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
      <input
        type="hidden"
        name={name}
        value={canonicalValue}
        data-e164-value={canonicalValue}
        readOnly
      />
      <PhoneInput
        id={inputId}
        international
        addInternationalOption={!hasActiveCountryPolicy}
        countryCallingCodeEditable={!hasActiveCountryPolicy}
        defaultCountry={effectiveDefaultCountry}
        countries={effectiveCountries}
        flagUrl={FLAG_URL}
        labels={phoneLabels}
        value={value}
        onChange={(v) => {
          const nextValue = v || "";
          buyerHasEdited.current = true;
          setValue(nextValue);
          setError("");
          persistCanonicalValue(normalizePhone(nextValue));
        }}
        onBlur={validate}
        required={required}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={placeholder || "Phone number"}
        className={`flex h-[46px] w-full rounded-lg border bg-muted px-3 text-base text-foreground shadow-sm transition-all md:h-9 ${error ? "border-destructive focus-within:border-destructive focus-within:ring-destructive/20" : "border-input focus-within:border-primary focus-within:ring-primary/20"} focus-within:bg-background focus-within:ring-1 [&_.PhoneInputInput]:h-full [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:text-base [&_.PhoneInputInput]:outline-none`}
      />
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-xs font-medium text-destructive"
        >
          {error}
        </p>
      ) : helpText ? (
        <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>
      ) : null}
    </div>
  );
}
