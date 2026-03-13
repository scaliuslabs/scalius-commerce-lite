// src/components/AuthModal.tsx
// Global Authentication Modal replacing inline login forms.
// Intercepts guest checkouts if disabled, allows choosing WhatsApp/Email.

import { useState, useEffect, useRef } from "react";
import { User, Mail, Smartphone, X } from "lucide-react";
import { sendCustomerOtp, verifyCustomerOtp, getCustomerSession, logoutCustomer, updateCustomerProfile, type CustomerInfo } from "@/lib/api/customer-auth";
import type { CheckoutConfig } from "@/lib/api/checkout";
import { createApiUrl } from "@/lib/api/client";

/**
 * Lightweight client-side fetch for checkout config.
 * Avoids importing the full getCheckoutConfig() which pulls in edge-cache.ts,
 * smart-cache.ts, and build-id.ts — SSR-only modules that bloat the client bundle
 * and add unnecessary chunks to the critical request chain.
 */
async function fetchCheckoutConfigClient(): Promise<CheckoutConfig | null> {
  try {
    const apiBase = (window as any).__API_BASE_URL__ || "/api/v1";
    const res = await fetch(`${apiBase}/checkout/config`);
    if (!res.ok) return null;
    return (await res.json()) as CheckoutConfig;
  } catch {
    return null;
  }
}

type VerificationMethod = "email" | "phone";
type Step = "method_select" | "input" | "otp" | "profile_setup" | "authenticated";

export default function AuthModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [method, setMethod] = useState<VerificationMethod>("email");
  const [identifier, setIdentifier] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [otp, setOtp] = useState("");

  // Settings injected globally
  const [allowedMethods, setAllowedMethods] = useState<"email" | "phone" | "both" | "email_phone_mandatory" | "whatsapp_otp" | "sms_otp">("both");

  const [customer, setCustomer] = useState<CustomerInfo | null>(null);

  // Profile Setup State
  const [profileName, setProfileName] = useState("");
  const [profileAddress, setProfileAddress] = useState("");
  const [profileCity, setProfileCity] = useState("");
  const [profileZone, setProfileZone] = useState("");
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);

  // Check session and settings on mount
  useEffect(() => {
    let isMounted = true;

    // Defer network requests until main thread is completely idle to fix Lighthouse chains
    const fetchInitData = () => {
      if (!isMounted) return;
      fetchCheckoutConfigClient().then((config) => {
        if (!isMounted || !config) return;
        if (config.authVerificationMethod) {
          setAllowedMethods(config.authVerificationMethod);
          if (config.authVerificationMethod === "whatsapp_otp" || config.authVerificationMethod === "sms_otp" || config.authVerificationMethod === "phone") {
            setMethod("phone");
          } else if (config.authVerificationMethod === "email") {
            setMethod("email");
          }
        }
      });

      getCustomerSession().then((state) => {
        if (!isMounted) return;
        if (state.authenticated && state.customer) {
          setCustomer(state.customer);
          setStep("authenticated");
          dispatchLoginEvent(state.customer);
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

    const handleOpen = () => setIsOpen(true);
    window.addEventListener("open-auth-modal", handleOpen);
    return () => {
      isMounted = false;
      window.removeEventListener("open-auth-modal", handleOpen);
      window.removeEventListener('load', fetchInitData);
    }
  }, []);

  // Fetch cities when profile setup begins
  useEffect(() => {
    if (step === "profile_setup") {
      fetch(createApiUrl("/locations/cities"))
        .then((res) => res.json())
        .then((data: any) => {
          if (data.success) setCities(data.data);
        })
        .catch(console.error);
    }
  }, [step]);

  // Fetch zones when city changes
  useEffect(() => {
    if (profileCity && step === "profile_setup") {
      fetch(createApiUrl(`/locations/zones?cityId=${profileCity}`))
        .then((res) => res.json())
        .then((data: any) => {
          if (data.success) {
            setZones(data.data);
            setProfileZone("");
          }
        })
        .catch(console.error);
    } else {
      setZones([]);
    }
  }, [profileCity, step]);

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

  const validateIdentifier = () => {
    if (method === "email") {
      const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());
      const phoneValid = /^\+?[0-9]{10,15}$/.test(phoneInput.trim());
      return emailValid && phoneValid;
    } else {
      const phoneValid = /^\+?[0-9]{10,15}$/.test(identifier.trim());
      if (allowedMethods === "email_phone_mandatory") {
        const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(phoneInput.trim());
        return phoneValid && emailValid;
      }
      return phoneValid;
    }
  };

  const handleSendOtp = async () => {
    if (!validateIdentifier()) {
      if (method === "email") {
        setError("Please enter a valid email address and phone number");
      } else {
        setError("Please enter a valid phone number");
      }
      return;
    }
    setLoading(true);
    setError("");
    const res = await sendCustomerOtp(method, identifier.trim());
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
    const res = await verifyCustomerOtp(method, identifier.trim(), otp.trim(), "", method === "email" ? phoneInput.trim() : "");
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

    const selectedCity = cities.find((c) => c.id === profileCity);
    const selectedZone = zones.find((z) => z.id === profileZone);

    const res = await updateCustomerProfile({
      name: profileName.trim(),
      address: profileAddress.trim(),
      city: profileCity,
      zone: profileZone,
      cityName: selectedCity?.name || "",
      zoneName: selectedZone?.name || "",
    });
    setLoading(false);

    if (res.success) {
      // Update local state with the new info so events are correct
      const updatedCustomer = {
        ...customer!,
        name: profileName.trim(),
        address: profileAddress.trim(),
        cityName: selectedCity?.name || "",
        zoneName: selectedZone?.name || "",
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
    setOtp("");
    window.dispatchEvent(new CustomEvent("customer-logout"));
  };

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
            {step === "authenticated" ? "Welcome back" : "Sign In"}
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
              <p className="text-sm text-muted-foreground mt-1">{customer.phone || customer.email}</p>
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

            {(allowedMethods === "both" || allowedMethods === "email_phone_mandatory") && (
              <div className="flex rounded-lg border border-border p-1 mb-4 bg-muted/50">
                <button
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${method === "email" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => { setMethod("email"); setError(""); setIdentifier(""); setPhoneInput(""); }}
                >
                  <Mail className="h-4 w-4" /> Email
                </button>
                <button
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${method === "phone" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => { setMethod("phone"); setError(""); setIdentifier(""); setPhoneInput(""); }}
                >
                  <Smartphone className="h-4 w-4" /> WhatsApp
                </button>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {method === "email" ? "Email address" : (allowedMethods === "sms_otp" ? "Phone Number" : "WhatsApp Number")}
              </label>
              <input
                type={method === "email" ? "email" : "tel"}
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                placeholder={method === "email" ? "you@example.com" : "+8801700000000"}
                className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all"
                autoFocus
              />
            </div>

            {method === "email" && (
              <div className="space-y-1.5 mt-2">
                <label className="text-sm font-medium text-foreground">Phone Number (Required)</label>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => { setPhoneInput(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  placeholder="+8801700000000"
                  className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring transition-all"
                />
              </div>
            )}

            {method === "phone" && (
              <div className="space-y-1.5 mt-2">
                <label className="text-sm font-medium text-foreground">
                  {allowedMethods === "email_phone_mandatory" ? "Email Address (Required)" : "Email Address (Optional)"}
                </label>
                <input
                  type="email"
                  value={phoneInput} // Reusing phoneInput state object variable contextually for email to save lines
                  onChange={(e) => { setPhoneInput(e.target.value); setError(""); }}
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
                {method === "email" ? <Mail className="h-6 w-6 text-primary" /> : <Smartphone className="h-6 w-6 text-primary" />}
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

            {error && <p className="text-xs text-center text-destructive font-medium">{error}</p>}

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
                Change {method}
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">City</label>
                  <select
                    value={profileCity}
                    onChange={(e) => { setProfileCity(e.target.value); setError(""); }}
                    className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none transition-all"
                  >
                    <option value="" disabled>Select City</option>
                    {cities.map((city) => (
                      <option key={city.id} value={city.id}>{city.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Zone</label>
                  <select
                    value={profileZone}
                    onChange={(e) => { setProfileZone(e.target.value); setError(""); }}
                    disabled={!profileCity || zones.length === 0}
                    className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:border-ring focus:outline-none transition-all disabled:opacity-50 disabled:bg-muted"
                  >
                    <option value="" disabled>Select Zone</option>
                    {zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>{zone.name}</option>
                    ))}
                  </select>
                </div>
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
