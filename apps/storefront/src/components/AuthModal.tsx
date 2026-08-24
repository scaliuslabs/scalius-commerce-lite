// src/components/AuthModal.tsx
// Global Authentication Modal replacing inline login forms.
// Intercepts guest checkouts if disabled, allows choosing WhatsApp/Email.

import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { User, Mail, Smartphone, X } from "lucide-react";
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

type Step = "method_select" | "input" | "otp" | "profile_setup" | "authenticated";
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const authSettingsPromiseRef = useRef<Promise<void> | null>(null);
  const sessionPromiseRef = useRef<Promise<void> | null>(null);
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

  // Fetch cities when profile setup begins
  useEffect(() => {
    if (step === "profile_setup") {
      fetch(createApiUrl("/locations/cities"))
        .then((res) => res.json())
        .then((data: { success: boolean; data: LocationData[] }) => {
          if (data.success) setCities(data.data);
        })
        .catch(console.error);
    }
  }, [step]);

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

  useEffect(() => {
    if (!isOpen) return;

    const dialog = dialogRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => dialog?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener("keydown", handleDialogKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      const previouslyFocused = previouslyFocusedElementRef.current;
      previouslyFocusedElementRef.current = null;
      window.requestAnimationFrame(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [handleClose, isOpen]);

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

  const handleSendOtp = async () => {
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
    if (!otp.trim() || otp.length !== 6) {
      setError("Enter the 6-digit verification code");
      return;
    }
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
    if (!profileName.trim() || !profileAddress.trim() || !profileCity.trim() || !profileZone.trim()) {
      setError("Please fill in your name, address, city, and zone.");
      return;
    }
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

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-2xl animate-in zoom-in-95 duration-200 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-auth-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 id="customer-auth-title" className="text-xl font-bold tracking-tight text-foreground">
            {step === "authenticated" ? "Welcome back" : authIntent === "sign_up" ? "Create Account" : "Sign In"}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Close account dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* State: Authenticated */}
        {step === "authenticated" && customer && (
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center p-6 bg-primary/5 rounded-lg border border-primary/10">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <User className="h-6 w-6 text-primary" />
              </div>
              <p className="font-medium text-foreground">{customer.name}</p>
              <p className="text-sm text-muted-foreground mt-1">{customer.phone ? formatPhoneForDisplay(customer.phone) : customer.email}</p>
            </div>
            <div className="flex gap-3">
              <a
                href="/account"
                data-astro-prefetch="false"
                className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border bg-background text-sm font-medium transition-colors hover:bg-muted"
              >
                Go to Dashboard
              </a>
              <button
                onClick={handleLogout}
                className="min-h-11 flex-1 rounded-lg bg-foreground text-sm font-medium text-background transition-colors hover:bg-foreground/90"
              >
                Sign out
              </button>
            </div>
          </div>
        )}

        {/* State: Method Selection or Input */}
        {step === "input" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Access your orders, track shipments, and checkout faster.
            </p>
            {authPolicyLoading && !authPolicyReady && (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                Loading sign-in options...
              </p>
            )}

            <div className="flex rounded-lg border border-border p-1 bg-muted/50">
              {(["sign_in", "sign_up"] as const).map((intent) => (
                <button
                  key={intent}
                  className={`min-h-11 flex-1 rounded-md text-sm font-medium transition-all ${authIntent === intent ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => { setAuthIntent(intent); setError(""); setOtp(""); }}
                >
                  {intent === "sign_in" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            {authUi.showMethodSwitcher && (
              <div className="flex rounded-lg border border-border p-1 mb-4 bg-muted/50">
                {authUi.requestOptions.map((option) => (
                  <button
                    key={option.channel}
                    className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium transition-all ${otpChannel === option.channel ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => { setOtpChannel(option.channel); setError(""); setIdentifier(""); setPhoneInput(""); setEmailInput(""); }}
                  >
                    {option.method === "email" ? <Mail className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
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
                  value={identifier}
                  onChange={(e) => { setIdentifier(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  placeholder="you@example.com"
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                />
              ) : (
                <PhoneInput
                  id="auth-primary-input"
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
              <div className="space-y-1.5 mt-2">
                <label htmlFor="auth-phone-input" className="text-sm font-medium text-foreground">{authUi.fields.phone.label}</label>
                <PhoneInput
                  id="auth-phone-input"
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
              <div className="space-y-1.5 mt-2">
                <label htmlFor="auth-email-input" className="text-sm font-medium text-foreground">
                  {authUi.fields.email.label}
                </label>
                <input
                  id="auth-email-input"
                  type="email"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  placeholder="you@example.com"
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}

            {error && (
              <div className="space-y-2">
                <p className="text-xs text-destructive font-medium">{error}</p>
                {alternateAuthIntent && alternateAuthIntent !== authIntent && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuthIntent(alternateAuthIntent);
                      setOtp("");
                      setError("");
                    }}
                    className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    {getCustomerAuthAlternateIntentLabel(alternateAuthIntent)}
                  </button>
                )}
              </div>
            )}

            <button
              onClick={handleSendOtp}
              disabled={authPolicyLoading || loading || !identifier.trim()}
              className="w-full h-11 rounded-lg bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-colors mt-2"
            >
              {authPolicyLoading ? "Loading options..." : loading ? "Please wait..." : "Continue"}
            </button>
          </div>
        )}

        {/* State: OTP Verification */}
        {step === "otp" && (
          <div className="space-y-5">
            <div className="text-center space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                {authUi.requestMethod === "email" ? <Mail className="h-6 w-6 text-primary" /> : <Smartphone className="h-6 w-6 text-primary" />}
              </div>
              <p className="text-sm text-muted-foreground">
                We've sent a 6-digit code to
              </p>
              <p className="font-semibold text-foreground">{identifier}</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="customer-otp" className="sr-only">Verification code</label>
              <input
                id="customer-otp"
                ref={otpInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otp}
                onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "")); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleVerifyOtp()}
                placeholder="• • • • • •"
                className="w-full h-12 text-center text-lg tracking-[0.5em] rounded-lg border border-input bg-background px-3 font-mono focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all"
              />
            </div>

            {error && (
              <div className="space-y-2 text-center">
                <p className="text-xs text-destructive font-medium">{error}</p>
                {alternateAuthIntent && alternateAuthIntent !== authIntent && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuthIntent(alternateAuthIntent);
                      setStep("input");
                      setOtp("");
                      setError("");
                    }}
                    className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    {getCustomerAuthAlternateIntentLabel(alternateAuthIntent)}
                  </button>
                )}
              </div>
            )}

            <button
              onClick={handleVerifyOtp}
              disabled={loading || otp.length !== 6}
              className="w-full h-11 rounded-lg bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-colors"
            >
              {loading ? "Verifying..." : "Verify Code"}
            </button>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => { setStep("input"); setOtp(""); setError(""); }}
                className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Change {authUi.currentOption.destinationLabel.toLowerCase()}
              </button>

              {countdown > 0 ? (
                <span className="text-xs text-muted-foreground">Resend code in {countdown}s</span>
              ) : (
                <button
                  onClick={handleSendOtp}
                  className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  Resend code
                </button>
              )}
            </div>
          </div>
        )}

        {/* State: Profile Setup (New Users) */}
        {step === "profile_setup" && (
          <div className="space-y-4">
            <div className="text-center space-y-2 mb-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <User className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">Complete your profile</h3>
              <p className="text-sm text-muted-foreground">Please provide your delivery details.</p>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="profile-name" className="text-xs font-medium text-foreground">
                  Full Name <span aria-hidden="true" className="ml-0.5 text-red-500">*</span><span className="sr-only"> (required)</span>
                </label>
                <input
                  id="profile-name"
                  type="text"
                  required
                  autoComplete="name"
                  value={profileName}
                  onChange={(e) => { setProfileName(e.target.value); setError(""); }}
                  placeholder="John Doe"
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none sm:h-10"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="profile-address" className="text-xs font-medium text-foreground">
                  Full Address <span aria-hidden="true" className="ml-0.5 text-red-500">*</span><span className="sr-only"> (required)</span>
                </label>
                <input
                  id="profile-address"
                  type="text"
                  required
                  autoComplete="street-address"
                  value={profileAddress}
                  onChange={(e) => { setProfileAddress(e.target.value); setError(""); }}
                  placeholder="Apt, Street, Building"
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base transition-all focus:border-ring focus:outline-none sm:h-10"
                />
              </div>

              <div>
                <LocationSelector
                  cities={cities}
                  cityLabel="City"
                  zoneLabel="Zone"
                  showAreaField={false}
                  onSelectionChange={handleProfileLocationChange}
                />
              </div>
            </div>

            {error && <p className="text-xs text-center text-destructive font-medium pt-1">{error}</p>}

            <button
              onClick={handleProfileSubmit}
              disabled={loading || !profileName.trim() || !profileAddress.trim() || !profileCity.trim() || !profileZone.trim()}
              className="w-full h-11 rounded-lg bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-colors mt-2"
            >
              {loading ? "Saving..." : "Save Delivery Details"}
            </button>
            {customer?.needsProfileCompletion && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={loading}
                className="w-full text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
