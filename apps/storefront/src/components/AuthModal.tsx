// src/components/AuthModal.tsx
// Global Authentication Modal replacing inline login forms.
// Intercepts guest checkouts if disabled, allows choosing WhatsApp/Email.

import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { X } from "lucide-react";
import { sendCustomerOtp, verifyCustomerOtp, getCustomerSession, logoutCustomer, updateCustomerProfile, type AuthState, type CustomerInfo } from "@/lib/api/customer-auth";
import type { CheckoutConfig } from "@/lib/api/checkout";
import { createApiUrl } from "@/lib/api/client";
import type { LocationData } from "@/lib/api";
import LocationSelector, { type LocationSelection } from "@/components/LocationSelector";
import PhoneInput, { getCountries } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { FLAG_URL } from "@scalius/shared/phone-flags";
import type { Country } from "react-phone-number-input";
import {
  getDefaultCustomerAuthOtpChannel,
  normalizeCustomerAuthPolicy,
  type CustomerAuthOtpChannel,
  type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import {
  getCustomerAuthAlternateIntent,
  getCustomerAuthAlternateIntentLabel,
  getCustomerAuthInputError,
  resolveCustomerAuthUi,
} from "@/lib/customer-auth-ui";
import {
  hasActivePhoneCountryPolicy,
  validateStorefrontPhone,
} from "@/lib/phone-country-policy";

/**
 * Lightweight client-side fetch for checkout config.
 * Avoids importing the full SSR checkout module and its generated SDK/runtime
 * dependencies into the client bundle's critical request chain.
 */
async function fetchCheckoutConfigClient(): Promise<CheckoutConfig | null> {
  try {
    const res = await fetch(createApiUrl("/checkout/config"));
    if (!res.ok) return null;
    const json = await res.json() as { success: boolean; data: CheckoutConfig };
    return json.data;
  } catch {
    return null;
  }
}

type AuthRuntimeSettings = {
  authPolicy: CustomerAuthPolicyConfig;
  otpChannel: CustomerAuthOtpChannel;
  allowedCountries: string[];
  allowedCountriesMode: "include" | "exclude";
  ready: boolean;
};

const FALLBACK_AUTH_SETTINGS: AuthRuntimeSettings = {
  authPolicy: normalizeCustomerAuthPolicy("both"),
  otpChannel: "email",
  allowedCountries: [],
  allowedCountriesMode: "include",
  ready: false,
};

function hasCustomerAuthMirrorCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim().startsWith("cs_auth=1"));
}

function readInjectedCheckoutConfig(): CheckoutConfig | null {
  if (typeof window === "undefined") return null;
  const value = window.__CHECKOUT_CONFIG__;
  if (!value || typeof value !== "object") return null;
  return value as CheckoutConfig;
}

function resolveAuthSettingsFromCheckoutConfig(config: CheckoutConfig | null): AuthRuntimeSettings {
  if (!config) return FALLBACK_AUTH_SETTINGS;
  const authPolicy = normalizeCustomerAuthPolicy(
    config.customerAuthPolicy,
    config.authVerificationMethod,
  );
  return {
    authPolicy,
    otpChannel: getDefaultCustomerAuthOtpChannel(authPolicy),
    allowedCountries: Array.isArray(config.allowedCountries) ? config.allowedCountries : [],
    allowedCountriesMode: config.allowedCountriesMode ?? "include",
    ready: true,
  };
}

function readInitialAuthSettings(): AuthRuntimeSettings {
  return resolveAuthSettingsFromCheckoutConfig(readInjectedCheckoutConfig());
}

type Step = "input" | "otp" | "profile_setup" | "authenticated";
type AuthIntent = "sign_in" | "sign_up";

export default function AuthModal() {
  const initialSettingsRef = useRef<AuthRuntimeSettings | null>(null);
  if (!initialSettingsRef.current) {
    initialSettingsRef.current = readInitialAuthSettings();
  }

  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [authIntent, setAuthIntent] = useState<AuthIntent>("sign_in");
  const [otpChannel, setOtpChannel] = useState<CustomerAuthOtpChannel>(
    initialSettingsRef.current.otpChannel,
  );
  const [identifier, setIdentifier] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [otp, setOtp] = useState("");

  // Settings injected globally
  const [authPolicy, setAuthPolicy] = useState<CustomerAuthPolicyConfig>(
    initialSettingsRef.current.authPolicy,
  );
  const [allowedCountries, setAllowedCountries] = useState<string[]>(
    initialSettingsRef.current.allowedCountries,
  );
  const [allowedCountriesMode, setAllowedCountriesMode] = useState<"include" | "exclude">(
    initialSettingsRef.current.allowedCountriesMode,
  );
  const [authPolicyReady, setAuthPolicyReady] = useState(initialSettingsRef.current.ready);
  const [authPolicyLoading, setAuthPolicyLoading] = useState(false);

  const [customer, setCustomer] = useState<CustomerInfo | null>(null);

  // Profile Setup State
  const [profileName, setProfileName] = useState("");
  const [profileAddress, setProfileAddress] = useState("");
  const [profileCity, setProfileCity] = useState("");
  const [profileZone, setProfileZone] = useState("");
  const [profileCityName, setProfileCityName] = useState("");
  const [profileZoneName, setProfileZoneName] = useState("");
  const [cities, setCities] = useState<LocationData[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(false);
  const [citiesLoadFailed, setCitiesLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const authSettingsPromiseRef = useRef<Promise<void> | null>(null);
  const sessionPromiseRef = useRef<Promise<void> | null>(null);
  const submissionInFlightRef = useRef(false);
  const initialProfileLocation = useMemo(() => ({
    city: customer?.city ?? "",
    cityName: customer?.cityName ?? "",
    zone: customer?.zone ?? "",
    zoneName: customer?.zoneName ?? "",
  }), [customer?.city, customer?.cityName, customer?.zone, customer?.zoneName]);
  const authUi = useMemo(
    () => resolveCustomerAuthUi(authPolicy, otpChannel, authIntent),
    [authPolicy, otpChannel, authIntent],
  );

  // Compute effective countries list based on mode
  const effectiveCountries = useMemo((): Country[] | undefined => {
    if (allowedCountries.length === 0) return undefined;
    if (allowedCountriesMode === "exclude") {
      const excluded = new Set(allowedCountries);
      return getCountries().filter((c) => !excluded.has(c));
    }
    return allowedCountries as Country[];
  }, [allowedCountries, allowedCountriesMode]);

  const phoneCountryPolicy = useMemo(
    () => ({ countries: allowedCountries, mode: allowedCountriesMode }),
    [allowedCountries, allowedCountriesMode],
  );
  const hasActiveCountryPolicy = hasActivePhoneCountryPolicy(phoneCountryPolicy);

  const effectiveDefaultCountry = useMemo(() => {
    if (effectiveCountries && effectiveCountries.length > 0) {
      return effectiveCountries[0];
    }
    if (hasActiveCountryPolicy) return undefined;
    return "BD" as Country;
  }, [effectiveCountries, hasActiveCountryPolicy]);

  const hydrateProfileFields = useCallback((customerData: CustomerInfo) => {
    setProfileName(customerData.name && customerData.name !== "Customer" ? customerData.name : "");
    setProfileAddress(customerData.address ?? "");
    setProfileCity(customerData.city ?? "");
    setProfileZone(customerData.zone ?? "");
    setProfileCityName(customerData.cityName ?? "");
    setProfileZoneName(customerData.zoneName ?? "");
  }, []);

  const applyAuthSettings = useCallback((settings: AuthRuntimeSettings) => {
    setAuthPolicy(settings.authPolicy);
    setOtpChannel(settings.otpChannel);
    setAllowedCountries(settings.allowedCountries);
    setAllowedCountriesMode(settings.allowedCountriesMode);
    setAuthPolicyReady(settings.ready);
  }, []);

  const ensureAuthSettings = useCallback(() => {
    if (authPolicyReady) return Promise.resolve();
    if (authSettingsPromiseRef.current) return authSettingsPromiseRef.current;

    const injected = readInjectedCheckoutConfig();
    if (injected) {
      applyAuthSettings(resolveAuthSettingsFromCheckoutConfig(injected));
      return Promise.resolve();
    }

    setAuthPolicyLoading(true);
    authSettingsPromiseRef.current = fetchCheckoutConfigClient()
      .then((config) => {
        applyAuthSettings(
          config
            ? resolveAuthSettingsFromCheckoutConfig(config)
            : { ...FALLBACK_AUTH_SETTINGS, ready: true },
        );
      })
      .finally(() => {
        setAuthPolicyLoading(false);
        authSettingsPromiseRef.current = null;
      });

    return authSettingsPromiseRef.current;
  }, [applyAuthSettings, authPolicyReady]);

  const applyCustomerSession = useCallback((state: AuthState, openIncompleteProfile: boolean) => {
    if (state.authenticated && state.customer) {
      setCustomer(state.customer);
      if (state.customer.needsProfileCompletion) {
        hydrateProfileFields(state.customer);
        setStep("profile_setup");
        if (openIncompleteProfile) setIsOpen(true);
      } else {
        setStep("authenticated");
      }
      return;
    }

    setCustomer(null);
    setStep("input");
  }, [hydrateProfileFields]);

  const hydrateExistingCustomerSession = useCallback((openIncompleteProfile: boolean) => {
    if (!hasCustomerAuthMirrorCookie()) {
      setCustomer(null);
      return Promise.resolve();
    }
    if (sessionPromiseRef.current) return sessionPromiseRef.current;

    sessionPromiseRef.current = getCustomerSession()
      .then((state) => {
        applyCustomerSession(state, openIncompleteProfile);
      })
      .finally(() => {
        sessionPromiseRef.current = null;
      });

    return sessionPromiseRef.current;
  }, [applyCustomerSession]);

  const scheduleCustomerSessionResume = useCallback(() => {
    const run = () => {
      if (!hasCustomerAuthMirrorCookie()) return;
      void hydrateExistingCustomerSession(true);
    };

    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 2500 });
      return;
    }

    window.setTimeout(run, 1);
  }, [hydrateExistingCustomerSession]);

  useEffect(() => {
    const handleOpen = (event?: Event) => {
      const activeElement = document.activeElement;
      previouslyFocusedElementRef.current = activeElement instanceof HTMLElement
        ? activeElement
        : null;
      const eventIntent = (event as CustomEvent<{ intent?: AuthIntent }> | undefined)?.detail?.intent;
      const requestedIntent = eventIntent ?? window.__scaliusAuthModalIntentPending;
      delete window.__scaliusAuthModalOpenPending;
      delete window.__scaliusAuthModalIntentPending;
      if (requestedIntent === "sign_in" || requestedIntent === "sign_up") {
        setAuthIntent(requestedIntent);
        setError("");
        setOtp("");
      }
      setIsOpen(true);
      void ensureAuthSettings();
      if (hasCustomerAuthMirrorCookie()) {
        void hydrateExistingCustomerSession(true);
      }
    };
    window.addEventListener("open-auth-modal", handleOpen);
    if (window.__scaliusAuthModalOpenPending) {
      handleOpen();
    } else if (hasCustomerAuthMirrorCookie()) {
      scheduleCustomerSessionResume();
    }
    return () => {
      window.removeEventListener("open-auth-modal", handleOpen);
    };
  }, [ensureAuthSettings, hydrateExistingCustomerSession, scheduleCustomerSessionResume]);

  useEffect(() => {
    if (authUi.otpChannel !== otpChannel) {
      setOtpChannel(authUi.otpChannel);
    }
  }, [authUi.otpChannel, otpChannel]);

  const loadProfileCities = useCallback(async () => {
    setCitiesLoading(true);
    setCitiesLoadFailed(false);
    try {
      const response = await fetch(createApiUrl("/locations/cities"), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Could not load cities");
      const payload = await response.json() as { success: boolean; data: LocationData[] };
      if (payload.success !== true || !Array.isArray(payload.data)) {
        throw new Error("Could not load cities");
      }
      setCities(payload.data);
    } catch {
      setCities([]);
      setCitiesLoadFailed(true);
    } finally {
      setCitiesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === "profile_setup") void loadProfileCities();
  }, [loadProfileCities, step]);

  // Clear stale profile location labels when the profile step is reset.
  useEffect(() => {
    if (step !== "profile_setup" || profileCity) return;
    setProfileZone("");
    setProfileCityName("");
    setProfileZoneName("");
  }, [profileCity, step]);

  const handleProfileLocationChange = (selection: LocationSelection) => {
    setProfileCity(selection.cityId);
    setProfileZone(selection.zoneId);
    setProfileCityName(selection.cityName);
    setProfileZoneName(selection.zoneName);
    setError("");
  };

  const dispatchLoginEvent = (customerData: CustomerInfo) => {
    window.dispatchEvent(new CustomEvent("customer-login", {
      detail: customerData,
    }));
  };

  const handleClose = useCallback(() => {
    if (step === "profile_setup" && customer?.needsProfileCompletion) {
      setError("Save your delivery profile or sign out to continue.");
      return;
    }
    setIsOpen(false);
  }, [customer?.needsProfileCompletion, step]);
  const handleCloseRef = useRef(handleClose);
  useEffect(() => {
    handleCloseRef.current = handleClose;
  }, [handleClose]);

  useEffect(() => {
    if (!isOpen) return;

    const dialog = dialogRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => dialog?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      const previouslyFocused = previouslyFocusedElementRef.current;
      previouslyFocusedElementRef.current = null;
      window.requestAnimationFrame(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [isOpen]);

  const startCountdown = (seconds: number) => {
    setCountdown(seconds);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(countdownRef.current!); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  useEffect(() => () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const handleSendOtp = async () => {
    if (submissionInFlightRef.current || authPolicyLoading) return;
    const validationError = getCustomerAuthInputError({
      authPolicy,
      otpChannel: authUi.otpChannel,
      intent: authIntent,
      identifier,
      phoneInput,
      emailInput,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    const authPhone = authUi.fields.phone.primary ? identifier : phoneInput;
    if (authUi.fields.phone.visible && authPhone.trim()) {
      const phoneValidation = validateStorefrontPhone(authPhone, phoneCountryPolicy);
      if (!phoneValidation.ok) {
        setError(phoneValidation.message || "Enter a valid phone number.");
        return;
      }
      if (authUi.fields.phone.primary) setIdentifier(phoneValidation.value);
      else setPhoneInput(phoneValidation.value);
    }
    submissionInFlightRef.current = true;
    setLoading(true);
    setError("");
    const res = await sendCustomerOtp({
      intent: authIntent,
      method: authUi.requestMethod,
      channel: authUi.otpChannel,
      identifier: identifier.trim(),
      phone: authUi.fields.phone.primary ? undefined : phoneInput.trim(),
      email: authUi.fields.email.primary ? undefined : emailInput.trim(),
    });
    submissionInFlightRef.current = false;
    setLoading(false);

    if (res.success) {
      setStep("otp");
      startCountdown(120);
      setTimeout(() => otpInputRef.current?.focus(), 100);
    } else {
      setError(res.error || "Failed to send code");
      if (res.retryAfter) startCountdown(res.retryAfter);
    }
  };

  const handleVerifyOtp = async () => {
    if (submissionInFlightRef.current) return;
    if (!otp.trim() || otp.length !== 6) {
      setError("Enter the 6-digit verification code");
      return;
    }
    submissionInFlightRef.current = true;
    setLoading(true);
    setError("");
    const res = await verifyCustomerOtp(
      {
        intent: authIntent,
        method: authUi.requestMethod,
        channel: authUi.otpChannel,
        identifier: identifier.trim(),
        code: otp.trim(),
        name: "",
        phone: authUi.fields.phone.primary ? undefined : phoneInput.trim(),
        email: authUi.fields.email.primary ? undefined : emailInput.trim(),
      },
    );
    submissionInFlightRef.current = false;
    setLoading(false);

    if (res.success && res.customer) {
      setCustomer(res.customer);

      if (res.isNewUser || res.customer.needsProfileCompletion) {
        hydrateProfileFields(res.customer);
        setStep("profile_setup");
      } else {
        setStep("authenticated");
        dispatchLoginEvent(res.customer);
        // Automatically close modal after 1.5s on success
        setTimeout(() => setIsOpen(false), 1500);
      }
    } else {
      setError(res.error || "Invalid code");
      if (res.attemptsLeft !== undefined && res.attemptsLeft <= 2) {
        setError(`${res.error || "Invalid code"} (${res.attemptsLeft} attempt${res.attemptsLeft !== 1 ? "s" : ""} left)`);
      }
    }
  };

  const handleProfileSubmit = async () => {
    if (submissionInFlightRef.current || citiesLoading || citiesLoadFailed) return;
    if (!profileName.trim() || !profileAddress.trim() || !profileCity.trim() || !profileZone.trim()) {
      setError("Please fill in your name, address, city, and zone.");
      return;
    }
    submissionInFlightRef.current = true;
    setLoading(true);
    setError("");

    const res = await updateCustomerProfile({
      name: profileName.trim(),
      address: profileAddress.trim(),
      city: profileCity,
      zone: profileZone,
      cityName: profileCityName,
      zoneName: profileZoneName,
    });
    submissionInFlightRef.current = false;
    setLoading(false);

    if (res.success) {
      const updatedCustomer = res.customer ?? {
        ...customer!,
        name: profileName.trim(),
        address: profileAddress.trim(),
        city: profileCity,
        zone: profileZone,
        cityName: profileCityName,
        zoneName: profileZoneName,
        profileComplete: true,
        needsProfileCompletion: false,
      };
      setCustomer(updatedCustomer);
      setStep("authenticated");
      dispatchLoginEvent(updatedCustomer);
      setTimeout(() => setIsOpen(false), 1500);
    } else {
      setError(res.error || "Failed to save profile");
    }
  };

  const handleLogout = async () => {
    // Clear the readable host-only auth mirror; the server clears cs_tok.
    await logoutCustomer();
    setCustomer(null);
    setStep("input");
    setIdentifier("");
    setPhoneInput("");
    setEmailInput("");
    setOtp("");
    setProfileName("");
    setProfileAddress("");
    setProfileCity("");
    setProfileZone("");
    setProfileCityName("");
    setProfileZoneName("");
    window.dispatchEvent(new CustomEvent("customer-logout"));
  };

  const alternateAuthIntent = getCustomerAuthAlternateIntent(error);

  if (!isOpen) return null;

  const title = step === "profile_setup"
    ? "Complete your profile"
    : step === "otp"
      ? "Verify your account"
      : step === "authenticated"
        ? "You're signed in"
        : authIntent === "sign_up" ? "Create account" : "Sign in";

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 p-4 text-foreground"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-auth-title"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
          <h2 id="customer-auth-title" className="text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close account dialog"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form
          method="post"
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={loading}
          onSubmit={(event) => {
            event.preventDefault();
            if (step === "input") void handleSendOtp();
            else if (step === "otp") void handleVerifyOtp();
            else if (step === "profile_setup") void handleProfileSubmit();
          }}
        >
          <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {step === "authenticated" && customer && (
              <div className="space-y-1">
                <p className="font-medium">{customer.name}</p>
                <p className="break-words text-sm text-muted-foreground">{customer.phone ? formatPhoneForDisplay(customer.phone) : customer.email}</p>
              </div>
            )}

            {step === "input" && (
              <div className="space-y-4">
                {authPolicyLoading && !authPolicyReady && (
                  <p role="status" className="text-sm text-muted-foreground">Loading sign-in options…</p>
                )}
                {authUi.showMethodSwitcher && (
                  <div className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1" role="group" aria-label="Verification method">
                    {authUi.requestOptions.map((option) => (
                      <button
                        type="button"
                        key={option.channel}
                        disabled={loading}
                        aria-pressed={otpChannel === option.channel}
                        className={`min-h-11 flex-1 rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${otpChannel === option.channel ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        onClick={() => { setOtpChannel(option.channel); setError(""); setIdentifier(""); setPhoneInput(""); setEmailInput(""); }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="auth-primary-input" className="text-sm font-medium text-foreground">
                    {authUi.currentOption.destinationLabel}
                  </label>
                  {authUi.fields.email.primary ? (
                    <input
                      id="auth-primary-input"
                      type="email"
                      disabled={loading}
                      value={identifier}
                      onChange={(e) => { setIdentifier(e.target.value); setError(""); }}
                      placeholder="you@example.com"
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                      autoComplete="email"
                      required
                    />
                  ) : (
                    <PhoneInput
                      id="auth-primary-input"
                      required
                      disabled={loading}
                      autoComplete="tel"
                      international
                      addInternationalOption={!hasActiveCountryPolicy}
                      countryCallingCodeEditable={!hasActiveCountryPolicy}
                      flagUrl={FLAG_URL}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input Country type is narrower than our string union
                      defaultCountry={effectiveDefaultCountry as any}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input countries prop expects exact Country[] tuple
                      countries={effectiveCountries as any}
                      value={identifier}
                      onChange={(value) => { setIdentifier(value || ""); setError(""); }}
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring [&_.PhoneInputInput]:h-full [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:text-base [&_.PhoneInputInput]:outline-none"
                    />
                  )}
                </div>

                {authUi.fields.phone.visible && !authUi.fields.phone.primary && (
                  <div className="space-y-1.5">
                    <label htmlFor="auth-phone-input" className="text-sm font-medium text-foreground">{authUi.fields.phone.label}</label>
                    <PhoneInput
                      id="auth-phone-input"
                      required={authUi.fields.phone.required}
                      disabled={loading}
                      autoComplete="tel"
                      international
                      addInternationalOption={!hasActiveCountryPolicy}
                      countryCallingCodeEditable={!hasActiveCountryPolicy}
                      flagUrl={FLAG_URL}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input Country type is narrower than our string union
                      defaultCountry={effectiveDefaultCountry as any}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input countries prop expects exact Country[] tuple
                      countries={effectiveCountries as any}
                      value={phoneInput}
                      onChange={(value) => { setPhoneInput(value || ""); setError(""); }}
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring [&_.PhoneInputInput]:h-full [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:text-base [&_.PhoneInputInput]:outline-none"
                    />
                  </div>
                )}

                {authUi.fields.email.visible && !authUi.fields.email.primary && (
                  <div className="space-y-1.5">
                    <label htmlFor="auth-email-input" className="text-sm font-medium text-foreground">
                      {authUi.fields.email.label}
                    </label>
                    <input
                      id="auth-email-input"
                      type="email"
                      required={authUi.fields.email.required}
                      disabled={loading}
                      autoComplete="email"
                      value={emailInput}
                      onChange={(e) => { setEmailInput(e.target.value); setError(""); }}
                      placeholder="you@example.com"
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                )}
              </div>
            )}

            {step === "otp" && (
              <div className="space-y-4">
                <p className="break-words text-sm text-muted-foreground">
                  Enter the 6-digit code sent to <span className="font-medium text-foreground">{identifier}</span>.
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="customer-otp" className="text-sm font-medium">Verification code</label>
                  <input
                    id="customer-otp"
                    ref={otpInputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    disabled={loading}
                    value={otp}
                    onChange={(event) => { setOtp(event.target.value.replace(/\D/g, "")); setError(""); }}
                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base tracking-[0.3em] focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => { setStep("input"); setOtp(""); setError(""); }}
                    className="min-h-11 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Change {authUi.currentOption.destinationLabel.toLowerCase()}
                  </button>
                  {countdown > 0 ? (
                    <span className="text-sm text-muted-foreground">Resend in {countdown}s</span>
                  ) : (
                    <button type="button" disabled={loading} onClick={handleSendOtp} className="min-h-11 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Resend code
                    </button>
                  )}
                </div>
              </div>
            )}

            {step === "profile_setup" && (
              <fieldset disabled={loading} className="min-w-0 space-y-3" aria-label="Delivery details">
                <div className="space-y-1.5">
                  <label htmlFor="profile-name" className="text-sm font-medium">
                    Full name <span aria-hidden="true" className="ml-0.5 text-destructive">*</span><span className="sr-only"> (required)</span>
                  </label>
                  <input
                    id="profile-name"
                    type="text"
                    required
                    autoComplete="name"
                    value={profileName}
                    onChange={(event) => { setProfileName(event.target.value); setError(""); }}
                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="profile-address" className="text-sm font-medium">
                    Delivery address <span aria-hidden="true" className="ml-0.5 text-destructive">*</span><span className="sr-only"> (required)</span>
                  </label>
                  <input
                    id="profile-address"
                    type="text"
                    required
                    autoComplete="street-address"
                    value={profileAddress}
                    onChange={(event) => { setProfileAddress(event.target.value); setError(""); }}
                    placeholder="House, road and building"
                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                {citiesLoading ? (
                  <p role="status" className="text-sm text-muted-foreground">Loading locations…</p>
                ) : citiesLoadFailed ? (
                  <div className="flex items-center justify-between gap-3">
                    <p role="alert" className="text-sm text-destructive">Could not load delivery locations.</p>
                    <button type="button" onClick={() => void loadProfileCities()} className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Retry
                    </button>
                  </div>
                ) : (
                  <LocationSelector
                    cities={cities}
                    initialLocation={initialProfileLocation}
                    className="sm:grid-cols-2"
                    cityLabel="City"
                    zoneLabel="Zone"
                    showAreaField={false}
                    onSelectionChange={handleProfileLocationChange}
                  />
                )}
              </fieldset>
            )}
          </div>

          <div className="shrink-0 space-y-3 border-t border-border px-4 py-4 sm:px-6">
            {error && (
              <div className="space-y-1">
                <p role="alert" className="text-sm font-medium text-destructive">{error}</p>
                {alternateAuthIntent && alternateAuthIntent !== authIntent && (step === "input" || step === "otp") && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => { setAuthIntent(alternateAuthIntent); setStep("input"); setOtp(""); setError(""); }}
                    className="min-h-11 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {getCustomerAuthAlternateIntentLabel(alternateAuthIntent)}
                  </button>
                )}
              </div>
            )}
            <div className="flex gap-3">
              {step === "authenticated" ? (
                <a href="/account" data-astro-prefetch="false" className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  View account
                </a>
              ) : (
                <button
                  type="submit"
                  disabled={loading || (step === "input" && (authPolicyLoading || !identifier.trim())) || (step === "otp" && otp.length !== 6) || (step === "profile_setup" && (citiesLoading || citiesLoadFailed || !profileName.trim() || !profileAddress.trim() || !profileCity.trim() || !profileZone.trim()))}
                  className="min-h-11 flex-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {step === "profile_setup" ? (loading ? "Saving…" : "Save delivery details") : step === "otp" ? (loading ? "Verifying…" : "Verify code") : authPolicyLoading ? "Loading options…" : loading ? "Sending…" : "Continue"}
                </button>
              )}
              {(step === "authenticated" || (step === "profile_setup" && customer?.needsProfileCompletion)) && (
                <button type="button" onClick={handleLogout} disabled={loading} className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Sign out
                </button>
              )}
            </div>
            {step === "input" && (
              <button
                type="button"
                disabled={loading}
                onClick={() => { setAuthIntent(authIntent === "sign_in" ? "sign_up" : "sign_in"); setError(""); setOtp(""); }}
                className="min-h-11 w-full text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {authIntent === "sign_in" ? "New here? Create account" : "Already have an account? Sign in"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
