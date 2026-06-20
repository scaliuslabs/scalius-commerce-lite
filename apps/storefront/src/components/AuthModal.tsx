// src/components/AuthModal.tsx
// Global Authentication Modal replacing inline login forms.
// Intercepts guest checkouts if disabled, allows choosing WhatsApp/Email.

import { useState, useEffect, useRef, useMemo } from "react";
import { User, Mail, Smartphone, X } from "lucide-react";
import { sendCustomerOtp, verifyCustomerOtp, getCustomerSession, logoutCustomer, updateCustomerProfile, type CustomerInfo } from "@/lib/api/customer-auth";
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

/**
 * Lightweight client-side fetch for checkout config.
 * Avoids importing the full getCheckoutConfig() which pulls in edge-cache.ts,
 * smart-cache.ts, and build-id.ts — SSR-only modules that bloat the client bundle
 * and add unnecessary chunks to the critical request chain.
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

type Step = "method_select" | "input" | "otp" | "profile_setup" | "authenticated";
type AuthIntent = "sign_in" | "sign_up";

export default function AuthModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [authIntent, setAuthIntent] = useState<AuthIntent>("sign_in");
  const [otpChannel, setOtpChannel] = useState<CustomerAuthOtpChannel>("email");
  const [identifier, setIdentifier] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [otp, setOtp] = useState("");

  // Settings injected globally
  const [authPolicy, setAuthPolicy] = useState<CustomerAuthPolicyConfig>(() => normalizeCustomerAuthPolicy("both"));
  const [allowedCountries, setAllowedCountries] = useState<string[]>([]);
  const [allowedCountriesMode, setAllowedCountriesMode] = useState<"include" | "exclude">("include");

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

  const effectiveDefaultCountry = useMemo(() => {
    if (effectiveCountries && effectiveCountries.length > 0) {
      return effectiveCountries[0];
    }
    return "BD" as Country;
  }, [effectiveCountries]);

  // Check session and settings on mount
  useEffect(() => {
    let isMounted = true;

    // Defer network requests until main thread is completely idle to fix Lighthouse chains
    const fetchInitData = () => {
      if (!isMounted) return;
      fetchCheckoutConfigClient().then((config) => {
        if (!isMounted || !config) return;
        const nextPolicy = normalizeCustomerAuthPolicy(
          config.customerAuthPolicy,
          config.authVerificationMethod,
        );
        setAuthPolicy(nextPolicy);
        setOtpChannel(getDefaultCustomerAuthOtpChannel(nextPolicy));
        if (Array.isArray(config.allowedCountries) && config.allowedCountries.length > 0) {
          setAllowedCountries(config.allowedCountries);
        }
        if (config.allowedCountriesMode) {
          setAllowedCountriesMode(config.allowedCountriesMode);
        }
      });

      getCustomerSession().then((state) => {
        if (!isMounted) return;
        if (state.authenticated && state.customer) {
          setCustomer(state.customer);
          setStep("authenticated");
        }
      });
    };

    // DEFER DEPENDENCY CHAIN: 
    // To prevent Lighthouse from flagging these API requests as "Critical Request Chains",
    // we strictly defer their execution until after the page's "load" event. 
    // This removes the network requests from the initial render waterfall entirely
    // while remaining highly predictable for future developers.
    if (document.readyState === 'complete') {
      // Yield to the event loop once to avoid blocking the current hydration thread
      setTimeout(fetchInitData, 1);
    } else {
      window.addEventListener('load', fetchInitData, { once: true });
    }

    const handleOpen = () => {
      delete window.__scaliusAuthModalOpenPending;
      setIsOpen(true);
    };
    window.addEventListener("open-auth-modal", handleOpen);
    if (window.__scaliusAuthModalOpenPending) {
      handleOpen();
    }
    return () => {
      isMounted = false;
      window.removeEventListener("open-auth-modal", handleOpen);
      window.removeEventListener('load', fetchInitData);
    };
  }, []);

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
      detail: {
        email: customerData.email,
        name: customerData.name,
        phone: customerData.phone,
        customerId: customerData.customerId,
      }
    }));
  };

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

      if (res.isNewUser) {
        // If it's a new user, force them through the profile setup flow
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
    if (!profileName.trim() || !profileCity.trim() || !profileZone.trim()) {
      setError("Please fill in your Name, City, and Zone");
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
      // Update local state with the new info so events are correct
      const updatedCustomer = {
        ...customer!,
        name: profileName.trim(),
        address: profileAddress.trim(),
        city: profileCity,
        zone: profileZone,
        cityName: profileCityName,
        zoneName: profileZoneName,
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
    // Clear cs_auth for both host-only and root domain
    const rootDomain = window.location.hostname.split(".").slice(-2).join(".");
    document.cookie = "cs_auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    document.cookie = `cs_auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.${rootDomain};`;

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
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-2xl animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            {step === "authenticated" ? "Welcome back" : authIntent === "sign_up" ? "Create Account" : "Sign In"}
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted transition-colors"
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
                className="flex-1 flex justify-center items-center h-10 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted transition-colors"
              >
                Go to Dashboard
              </a>
              <button
                onClick={handleLogout}
                className="flex-1 h-10 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors"
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

            <div className="flex rounded-lg border border-border p-1 bg-muted/50">
              {(["sign_in", "sign_up"] as const).map((intent) => (
                <button
                  key={intent}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${authIntent === intent ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
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
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${otpChannel === option.channel ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => { setOtpChannel(option.channel); setError(""); setIdentifier(""); setPhoneInput(""); setEmailInput(""); }}
                  >
                    {option.method === "email" ? <Mail className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {authUi.currentOption.destinationLabel}
              </label>
              {authUi.fields.email.primary ? (
                <input
                  type="email"
                  value={identifier}
                  onChange={(e) => { setIdentifier(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  placeholder="you@example.com"
                  className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all"
                  autoFocus
                />
              ) : (
                <PhoneInput
                  international
                  flagUrl={FLAG_URL}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input Country type is narrower than our string union
                  defaultCountry={effectiveDefaultCountry as any}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input countries prop expects exact Country[] tuple
                  countries={effectiveCountries as any}
                  value={identifier}
                  onChange={(value) => { setIdentifier(value || ""); setError(""); }}
                  className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:outline-none [&_.PhoneInputInput]:text-sm [&_.PhoneInputInput]:h-full"
                />
              )}
            </div>

            {authUi.fields.phone.visible && !authUi.fields.phone.primary && (
              <div className="space-y-1.5 mt-2">
                <label className="text-sm font-medium text-foreground">{authUi.fields.phone.label}</label>
                <PhoneInput
                  international
                  flagUrl={FLAG_URL}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input Country type is narrower than our string union
                  defaultCountry={effectiveDefaultCountry as any}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-phone-number-input countries prop expects exact Country[] tuple
                  countries={effectiveCountries as any}
                  value={phoneInput}
                  onChange={(value) => { setPhoneInput(value || ""); setError(""); }}
                  className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all [&_.PhoneInputInput]:border-none [&_.PhoneInputInput]:bg-transparent [&_.PhoneInputInput]:outline-none [&_.PhoneInputInput]:text-sm [&_.PhoneInputInput]:h-full"
                />
              </div>
            )}

            {authUi.fields.email.visible && !authUi.fields.email.primary && (
              <div className="space-y-1.5 mt-2">
                <label className="text-sm font-medium text-foreground">
                  {authUi.fields.email.label}
                </label>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  placeholder="you@example.com"
                  className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all"
                />
              </div>
            )}

            {error && <p className="text-xs text-destructive font-medium">{error}</p>}

            <button
              onClick={handleSendOtp}
              disabled={loading || !identifier.trim()}
              className="w-full h-11 rounded-lg bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-colors mt-2"
            >
              {loading ? "Please wait..." : "Continue"}
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
              <input
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
                <label className="text-xs font-medium text-foreground">Full Name</label>
                <input
                  type="text"
                  value={profileName}
                  onChange={(e) => { setProfileName(e.target.value); setError(""); }}
                  placeholder="John Doe"
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Full Address</label>
                <input
                  type="text"
                  value={profileAddress}
                  onChange={(e) => { setProfileAddress(e.target.value); setError(""); }}
                  placeholder="Apt, Street, Building"
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none transition-all"
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
              disabled={loading || !profileName.trim() || !profileCity.trim() || !profileZone.trim()}
              className="w-full h-11 rounded-lg bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-colors mt-2"
            >
              {loading ? "Saving..." : "Save Delivery Details"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
