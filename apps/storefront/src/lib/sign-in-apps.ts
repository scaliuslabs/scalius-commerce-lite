// "Continue with <app>" on the sign-in page and dialog. An active app approved
// for the identity port appears in the layout's `appServices.signIn`; each is a
// plain link to the storefront's same-origin customer-auth proxy, which
// carries the buyer to the app's sign-in page and back with a session. A link
// works without JavaScript. Failures come back as a fixed `sign_in_error`
// value in the account page's URL: never a provider message.
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language-format";

export interface SignInApp {
  /** The app provider id (`<plugin id>:<provider id>`). */
  id: string;
  /** The merchant-facing name ("Google"). */
  name: string;
}

export type SignInLanguage = "en" | "bn";

/** The id's characters are all valid in a URL path segment as they are. */
const APP_PROVIDER_ID = /^[a-z0-9][a-z0-9.-]*:[a-z][a-z0-9_-]*$/;

export function signInLanguage(code: unknown): SignInLanguage {
  return checkoutLanguageBaseCode(code) === "bn" ? "bn" : "en";
}

/** The sign-in apps a layout (or a page global) names; anything malformed is dropped. */
export function readSignInApps(value: unknown): SignInApp[] {
  if (!Array.isArray(value)) return [];
  const apps: SignInApp[] = [];
  for (const entry of value) {
    const { id, name } = (entry ?? {}) as Partial<SignInApp>;
    if (typeof id === "string" && id.length <= 150 && APP_PROVIDER_ID.test(id) && typeof name === "string" && name.trim()) {
      apps.push({ id, name: name.trim().slice(0, 60) });
    }
  }
  return apps.slice(0, 6);
}

/**
 * Where "Continue with <app>" goes: the same-origin proxy of the API's start
 * route. `returnTo` is a storefront path (the API accepts only same-site
 * paths); `locale` is the page language for the app's sign-in page.
 */
export function signInAppHref(app: SignInApp, options: { returnTo?: string; locale?: string } = {}): string {
  const query = new URLSearchParams();
  if (options.returnTo?.startsWith("/")) query.set("returnTo", options.returnTo);
  if (options.locale && /^[a-z]{2}$/.test(options.locale)) query.set("locale", options.locale);
  const search = query.toString();
  return `/api/customer-auth/identity/${app.id}/start${search ? `?${search}` : ""}`;
}

export function continueWithLabel(name: string, language: SignInLanguage): string {
  return language === "bn" ? `${name} দিয়ে চালিয়ে যান` : `Continue with ${name}`;
}

const ERROR_COPY: Record<SignInLanguage, Record<"identity" | "needs_details", string>> = {
  en: {
    identity: "We couldn't sign you in with that account. Try again, or sign in with a code.",
    needs_details: "We need a few more details to create your account. Sign in with your email or phone to finish.",
  },
  bn: {
    identity: "ওই অ্যাকাউন্ট দিয়ে সাইন ইন করা যায়নি। আবার চেষ্টা করুন, অথবা কোড দিয়ে সাইন ইন করুন।",
    needs_details: "আপনার অ্যাকাউন্ট তৈরি করতে আরও কিছু তথ্য দরকার। ইমেইল বা ফোন দিয়ে সাইন ইন করে শেষ করুন।",
  },
};

/** The message for a `sign_in_error` value, or null for anything else. */
export function signInErrorMessage(value: string | null | undefined, language: SignInLanguage): string | null {
  return value === "identity" || value === "needs_details" ? ERROR_COPY[language][value] : null;
}
