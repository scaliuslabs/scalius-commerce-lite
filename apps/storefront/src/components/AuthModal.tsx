// src/components/AuthModal.tsx
// The one sign-in dialog (Shopify-style): enter an email or phone, get a
// code, and you're in. A new buyer adds their name (and phone) after the code
// proves their contact; nobody is asked whether they "have an account".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  getCustomerSession,
  sendCustomerOtp,
  verifyCustomerOtp,
  type AuthState,
  type CustomerInfo,
  type NewCustomerAccountDetails,
  type NewCustomerSuggestion,
} from "@/lib/api/customer-auth";
import { signOutCustomer } from "@/lib/customer-sign-out";
import { focusMainHeading } from "@/lib/focus-main-heading";
import type { CheckoutConfig } from "@/lib/api/checkout";
import { createApiUrl } from "@/lib/api/transport";
import type { CustomerAuthOtpChannel, CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import type { PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import {
  checkContact,
  checkNewAccount,
  formatWait,
  resolveCustomerAuthUi,
} from "@/lib/customer-auth-ui";

export interface AuthModalPrefill {
  name?: string;
  email?: string;
  phone?: string;
}

/** The `open-auth-modal` event detail. A receipt opens it for that order's buyer. */
export interface AuthModalOpenDetail {
  prefill?: AuthModalPrefill;
  source?: "receipt";
}

type Field = "contact" | "code" | "name" | "phone" | "email";

type Step = "contact" | "code" | "details" | "signed_in";

interface AuthSettings {
  /** Customer accounts, as published: only chosen channels that can send. */
  identity: CustomerIdentitySettings | null;
  phonePolicy: PhoneCountryPolicy;
  ready: boolean;
}

function settingsFromConfig(config: CheckoutConfig | null | undefined): AuthSettings {
  if (!config) {
    return { identity: null, phonePolicy: { countries: [], mode: "include" }, ready: false };
  }
  return {
    identity: config.customerIdentity ?? null,
    phonePolicy: {
      countries: Array.isArray(config.allowedCountries) ? config.allowedCountries : [],
      mode: config.allowedCountriesMode ?? "include",
    },
    ready: true,
  };
}

async function fetchCheckoutConfig(): Promise<CheckoutConfig | null> {
  try {
    const res = await fetch(createApiUrl("/checkout/config"));
    if (!res.ok) return null;
    const json = await res.json() as { success: boolean; data: CheckoutConfig };
    return json.data ?? null;
  } catch {
    return null;
  }
}

function hasCustomerAuthMirrorCookie(): boolean {
  return typeof document !== "undefined"
    && document.cookie.split(";").some((cookie) => cookie.trim().startsWith("cs_auth=1"));
}

const inputClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-base focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 aria-[invalid=true]:border-destructive";
const linkButtonClass =
  "min-h-11 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground disabled:no-underline";

/** Counts down once per second; `start(0)` clears it. */
function useCountdown(): [number, (seconds: number) => void] {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const id = window.setTimeout(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [seconds]);
  return [seconds, useCallback((value: number) => setSeconds(Math.max(0, Math.ceil(value))), [])];
}

export default function AuthModal() {
  const [settings, setSettings] = useState<AuthSettings>(() => settingsFromConfig(window.__CHECKOUT_CONFIG__ as CheckoutConfig | undefined));
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("contact");
  const [channel, setChannel] = useState<CustomerAuthOtpChannel>(() => resolveCustomerAuthUi(settings.identity).otpChannel);
  const [contact, setContact] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [details, setDetails] = useState({ name: "", phone: "", email: "" });
  /** The latest order's address a new buyer can save; the server copies it. */
  const [orderAddress, setOrderAddress] = useState<NewCustomerSuggestion["address"]>(null);
  const [saveOrderAddress, setSaveOrderAddress] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  /** The server's rate-limit sentence, shown with the wait while it runs. */
  const [limit, setLimit] = useState("");
  const [fromReceipt, setFromReceipt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [resendWait, startResendWait] = useCountdown();
  const [sendWait, startSendWait] = useCountdown();
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /** Set by a sign-in in this opening; focus then goes to the page's heading on close. */
  const signedInRef = useRef(false);
  const prefillRef = useRef<AuthModalPrefill>({});

  const ui = useMemo(() => resolveCustomerAuthUi(settings.identity, channel), [settings.identity, channel]);
  const isEmail = ui.requestMethod === "email";
  const locked = attemptsLeft === 0;

  const applySession = useCallback((state: AuthState) => {
    if (state.authenticated && state.customer) {
      setCustomer(state.customer);
      setStep("signed_in");
    } else if (!state.unavailable) {
      setCustomer(null);
    }
  }, []);

  const methodRef = useRef(ui.requestMethod);
  methodRef.current = ui.requestMethod;
  const customerRef = useRef(customer);
  customerRef.current = customer;
  const settingsReadyRef = useRef(settings.ready);
  settingsReadyRef.current = settings.ready;
  const stepRef = useRef(step);
  stepRef.current = step;
  const sentToRef = useRef(sentTo);
  sentToRef.current = sentTo;

  const resetFlow = useCallback((prefill: AuthModalPrefill) => {
    setStep("contact");
    setCode("");
    setAttemptsLeft(null);
    setError("");
    setLimit("");
    setFieldErrors({});
    setOrderAddress(null);
    const phone = prefill.phone ? formatBdMobile(prefill.phone) : "";
    setContact(methodRef.current === "email" ? prefill.email ?? "" : phone);
    setDetails({ name: prefill.name ?? "", phone, email: prefill.email ?? "" });
  }, []);

  useEffect(() => {
    const open = (event?: Event) => {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
      const detail = (event as CustomEvent<AuthModalOpenDetail | undefined> | undefined)?.detail
        ?? window.__scaliusAuthModalDetailPending;
      delete window.__scaliusAuthModalOpenPending;
      delete window.__scaliusAuthModalDetailPending;
      const prefill = detail?.prefill ?? {};
      prefillRef.current = prefill;
      setFromReceipt(detail?.source === "receipt");
      setIsOpen(true);
      // A sent or accepted code stays valid for minutes: reopening continues
      // there (no new code, no resend wait) unless it opens for someone else.
      const wanted = methodRef.current === "email" ? prefill.email : prefill.phone;
      const checked = wanted ? checkContact(methodRef.current, wanted) : null;
      const continues = (stepRef.current === "code" || stepRef.current === "details")
        && (!checked || (checked.ok && checked.value === sentToRef.current));
      if (!customerRef.current && !continues) resetFlow(prefill);
      if (!settingsReadyRef.current) {
        void fetchCheckoutConfig().then((config) => {
          const next = settingsFromConfig(config);
          setSettings({ ...next, ready: true });
          setChannel(resolveCustomerAuthUi(next.identity).otpChannel);
        });
      }
      if (hasCustomerAuthMirrorCookie()) void getCustomerSession().then(applySession);
    };
    window.addEventListener("open-auth-modal", open);
    if (window.__scaliusAuthModalOpenPending) open();
    else if (hasCustomerAuthMirrorCookie()) void getCustomerSession().then(applySession);
    return () => window.removeEventListener("open-auth-modal", open);
  }, [applySession, resetFlow]);

  const close = useCallback(() => setIsOpen(false), []);

  // While open the page doesn't scroll. On close focus returns to the opener,
  // or, after signing in (the page now shows the account or the order), to
  // the page's main heading. Once per close, never on a step change.
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      const signedInHere = signedInRef.current;
      signedInRef.current = false;
      window.requestAnimationFrame(() => {
        if (signedInHere && focusMainHeading()) return;
        if (target?.isConnected) target.focus();
      });
    };
  }, [isOpen]);

  // Focus the first field on every step; trap Tab; Esc closes.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const frame = window.requestAnimationFrame(() => {
      const first = dialog?.querySelector<HTMLElement>("[data-autofocus]");
      (first ?? dialog)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled)',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, isOpen, step]);

  const run = async (task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const sendCode = () => run(async () => {
    const checked = checkContact(ui.requestMethod, contact, settings.phonePolicy);
    if (!checked.ok) {
      setFieldErrors({ contact: checked.message });
      return;
    }
    setFieldErrors({});
    setError("");
    setLimit("");
    const result = await sendCustomerOtp({ method: ui.requestMethod, channel: ui.otpChannel, identifier: checked.value });
    if (!result.success) {
      if (!result.retryAfterSeconds) {
        setError(result.error);
        return;
      }
      setLimit(result.error);
      startSendWait(result.retryAfterSeconds);
      startResendWait(result.retryAfterSeconds);
      // The code already sent to this contact still works: stay on it.
      if (checked.value === sentTo) setStep("code");
      return;
    }
    setSentTo(checked.value);
    setCode("");
    setAttemptsLeft(null);
    startResendWait(result.resendAfterSeconds);
    setStep("code");
  });

  const signedIn = (next: CustomerInfo) => {
    signedInRef.current = true;
    setCustomer(next);
    setStep("signed_in");
    window.dispatchEvent(new CustomEvent("customer-login", { detail: next }));
    window.setTimeout(() => setIsOpen(false), 1500);
  };

  const verifyCode = (account?: NewCustomerAccountDetails) => run(async () => {
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: "Enter the 6-digit code." });
      return;
    }
    setFieldErrors({});
    setError("");
    setLimit("");
    const result = await verifyCustomerOtp({
      method: ui.requestMethod,
      channel: ui.otpChannel,
      identifier: sentTo,
      code,
      ...(account ? { account } : {}),
    });
    if (!result.success) {
      setAttemptsLeft(result.attemptsLeft ?? null);
      const left = result.attemptsLeft;
      setError(left && left <= 2 ? `${result.error} ${left === 1 ? "1 attempt left." : `${left} attempts left.`}` : result.error);
      if (left === 0) {
        startResendWait(0);
        if (step === "details") setStep("code");
      }
      return;
    }
    if (result.status === "needs_account_details") {
      // What the store already knows from this contact's latest order; typed values win.
      const suggestion = result.suggestion;
      if (suggestion) {
        setDetails((value) => ({
          name: value.name.trim() ? value.name : suggestion.name ?? "",
          phone: value.phone.trim() ? value.phone : suggestion.phone ? formatBdMobile(suggestion.phone) : "",
          email: value.email.trim() ? value.email : suggestion.email ?? "",
        }));
      }
      setOrderAddress(suggestion?.address ?? null);
      setSaveOrderAddress(true);
      setStep("details");
      return;
    }
    signedIn(result.customer);
  });

  const submitDetails = () => {
    const checked = checkNewAccount(ui, details, settings.phonePolicy);
    if (!checked.ok) {
      setFieldErrors(Object.fromEntries(checked.errors.map(({ field, message }) => [field, message])));
      dialogRef.current?.querySelector<HTMLInputElement>(`#auth-${checked.errors[0]!.field}`)?.focus();
      return;
    }
    void verifyCode({ ...checked.account, saveOrderAddress: Boolean(orderAddress) && saveOrderAddress });
  };

  const signOut = () => run(async () => {
    // Also empties this browser's cart and checkout state (shared devices).
    await signOutCustomer();
    signedInRef.current = false;
    setCustomer(null);
    resetFlow({});
  });

  if (!isOpen) return null;

  const title = step === "signed_in"
    ? "You're signed in"
    : step === "details" ? "Create your account" : "Sign in";
  const destinationLabel = isEmail ? "Email" : "Phone number";
  const errorFor = (field: Field) => fieldErrors[field] ?? "";
  const clearError = (field: Field) => setFieldErrors(({ [field]: _cleared, ...rest }) => rest);
  // The wait shows once: on the code step the resend button counts it down.
  const alertText = error || (limit && sendWait > 0
    ? step === "code" ? limit : `${limit} Try again in ${formatWait(sendWait)}.`
    : "");

  return (
    <div
      className="fixed inset-0 z-100 flex items-end justify-center bg-black/50 text-foreground sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-auth-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-border bg-background shadow-xl focus:outline-none sm:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
          <h2 id="customer-auth-title" className="text-xl font-semibold">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form
          method="post"
          noValidate
          aria-busy={loading}
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (step === "contact") void sendCode();
            else if (step === "code") void verifyCode();
            else if (step === "details") submitDetails();
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {step === "signed_in" && customer && (
              <div className="space-y-1">
                <p className="font-medium">{customer.name}</p>
                <p className="break-words text-sm text-muted-foreground">
                  {customer.email || (customer.phone ? formatBdMobile(customer.phone) : "")}
                </p>
              </div>
            )}

            {step === "contact" && (
              <>
                <p className="text-sm text-muted-foreground">
                  {isEmail
                    ? "Enter your email and we'll send you a code. New here? We'll set up your account."
                    : "Enter your mobile number and we'll text you a code. New here? We'll set up your account."}
                </p>
                {ui.showMethodSwitcher && (
                  <div className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1" role="group" aria-label="Sign in with">
                    {ui.requestOptions.map((option) => (
                      <button
                        type="button"
                        key={option.channel}
                        disabled={loading}
                        aria-pressed={channel === option.channel}
                        onClick={() => {
                          setChannel(option.channel);
                          setFieldErrors({});
                          setError("");
                          const prefill = prefillRef.current;
                          setContact(option.method === "email" ? prefill.email ?? "" : prefill.phone ? formatBdMobile(prefill.phone) : "");
                        }}
                        className={`min-h-11 flex-1 rounded-md px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${channel === option.channel ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {option.method === "email" ? "Email" : option.channel === "whatsapp" ? "WhatsApp" : "Phone"}
                      </button>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="auth-contact" className="text-sm font-medium">{destinationLabel}</label>
                  <input
                    id="auth-contact"
                    data-autofocus
                    type={isEmail ? "email" : "tel"}
                    inputMode={isEmail ? "email" : "tel"}
                    autoComplete={isEmail ? "email" : "tel-national"}
                    placeholder={isEmail ? "name@example.com" : "01XXXXXXXXX"}
                    disabled={loading}
                    value={contact}
                    aria-invalid={Boolean(errorFor("contact"))}
                    aria-describedby={errorFor("contact") ? "auth-contact-error" : undefined}
                    onChange={(event) => {
                      setContact(event.target.value);
                      clearError("contact");
                      setError("");
                      // A limit belongs to the contact it was for; another one may send.
                      setLimit("");
                      startSendWait(0);
                    }}
                    onBlur={() => {
                      if (!contact.trim()) return;
                      const checked = checkContact(ui.requestMethod, contact, settings.phonePolicy);
                      if (!checked.ok) setFieldErrors({ contact: checked.message });
                      else if (!isEmail) setContact(formatBdMobile(checked.value));
                    }}
                    className={inputClass}
                  />
                  {errorFor("contact") && <p id="auth-contact-error" className="text-sm text-destructive">{errorFor("contact")}</p>}
                  {settings.ready && !ui.available && (
                    <p data-sign-in-unavailable role="alert" className="text-sm text-destructive">
                      Sign-in codes aren't available right now. Contact the store.
                    </p>
                  )}
                  {settings.ready && ui.available && !ui.phoneSignIn && (
                    <p data-phone-sign-in-note className="text-sm text-muted-foreground">
                      Phone sign-in isn't available yet. Use your email.
                    </p>
                  )}
                </div>
              </>
            )}

            {step === "code" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Enter the 6-digit code we sent to{" "}
                  <span className="break-all font-medium text-foreground">{isEmail ? sentTo : formatBdMobile(sentTo)}</span>.
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="customer-otp" className="text-sm font-medium">Code</label>
                  <input
                    id="customer-otp"
                    data-autofocus
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    disabled={loading || locked}
                    value={code}
                    aria-invalid={Boolean(errorFor("code"))}
                    aria-describedby={errorFor("code") ? "auth-code-error" : undefined}
                    onChange={(event) => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); clearError("code"); }}
                    className={`${inputClass} tracking-[0.3em]`}
                  />
                  {errorFor("code") && <p id="auth-code-error" className="text-sm text-destructive">{errorFor("code")}</p>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => { setStep("contact"); setCode(""); setError(""); setAttemptsLeft(null); }}
                    className="min-h-11 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isEmail ? "Use a different email" : "Use a different number"}
                  </button>
                  <button type="button" disabled={loading || resendWait > 0} onClick={() => void sendCode()} className={linkButtonClass}>
                    {resendWait > 0 ? `Send a new code in ${formatWait(resendWait)}` : "Send a new code"}
                  </button>
                </div>
              </>
            )}

            {step === "details" && (
              <>
                <p className="text-sm text-muted-foreground">
                  {isEmail ? "Your email is confirmed." : "Your number is confirmed."} Add your details to finish.
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="auth-name" className="text-sm font-medium">Full name</label>
                  <input
                    id="auth-name"
                    data-autofocus
                    type="text"
                    autoComplete="name"
                    disabled={loading}
                    value={details.name}
                    aria-invalid={Boolean(errorFor("name"))}
                    aria-describedby={errorFor("name") ? "auth-name-error" : undefined}
                    onChange={(event) => { setDetails((value) => ({ ...value, name: event.target.value })); clearError("name"); }}
                    className={inputClass}
                  />
                  {errorFor("name") && <p id="auth-name-error" className="text-sm text-destructive">{errorFor("name")}</p>}
                </div>
                {ui.newAccount.phone !== "hidden" && (
                  <div className="space-y-1.5">
                    <label htmlFor="auth-phone" className="text-sm font-medium">
                      Phone number{ui.newAccount.phone === "optional" ? " (optional)" : ""}
                    </label>
                    <input
                      id="auth-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      placeholder="01XXXXXXXXX"
                      disabled={loading}
                      value={details.phone}
                      aria-invalid={Boolean(errorFor("phone"))}
                      aria-describedby={errorFor("phone") ? "auth-phone-help auth-phone-error" : "auth-phone-help"}
                      onChange={(event) => { setDetails((value) => ({ ...value, phone: event.target.value })); clearError("phone"); }}
                      className={inputClass}
                    />
                    <p id="auth-phone-help" className="text-sm text-muted-foreground">Couriers call this number to deliver.</p>
                    {errorFor("phone") && <p id="auth-phone-error" className="text-sm text-destructive">{errorFor("phone")}</p>}
                  </div>
                )}
                {ui.newAccount.email !== "hidden" && (
                  <div className="space-y-1.5">
                    <label htmlFor="auth-email" className="text-sm font-medium">
                      Email{ui.newAccount.email === "optional" ? " (optional)" : ""}
                    </label>
                    <input
                      id="auth-email"
                      type="email"
                      autoComplete="email"
                      disabled={loading}
                      value={details.email}
                      aria-invalid={Boolean(errorFor("email"))}
                      aria-describedby={errorFor("email") ? "auth-email-error" : undefined}
                      onChange={(event) => { setDetails((value) => ({ ...value, email: event.target.value })); clearError("email"); }}
                      className={inputClass}
                    />
                    {errorFor("email") && <p id="auth-email-error" className="text-sm text-destructive">{errorFor("email")}</p>}
                  </div>
                )}
                {orderAddress && (
                  <label htmlFor="auth-save-address" className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
                    <input
                      id="auth-save-address"
                      type="checkbox"
                      disabled={loading}
                      checked={saveOrderAddress}
                      onChange={(event) => setSaveOrderAddress(event.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {orderAddress.orderNumber != null
                          ? `Save the delivery address from order ${formatOrderNumber(orderAddress.orderNumber, "")}`
                          : "Save the delivery address from your last order"}
                      </span>
                      <span className="block break-words text-muted-foreground">{orderAddress.text}</span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>

          <div className="shrink-0 space-y-3 border-t border-border px-4 py-4 sm:px-6">
            {alertText && <p role="alert" className="text-sm font-medium text-destructive">{alertText}</p>}
            <div className="flex gap-3">
              {step === "signed_in" ? (
                <>
                  <a
                    href="/account"
                    data-astro-prefetch="false"
                    className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    View account
                  </a>
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    disabled={loading}
                    className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={
                    loading
                    || (step === "contact" && (!contact.trim() || sendWait > 0))
                    || (step === "code" && (code.length !== 6 || locked))
                  }
                  className="min-h-11 flex-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {loading
                    ? step === "contact" ? "Sending…" : step === "code" ? "Checking…" : "Creating account…"
                    : step === "contact" ? "Send code" : step === "code" ? "Continue" : "Create account"}
                </button>
              )}
            </div>
            {step === "contact" && !fromReceipt && (
              <p className="text-center text-sm text-muted-foreground">
                Ordered as a guest? <a href="/track-order" className="font-medium text-primary hover:underline">Track your order</a>
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
