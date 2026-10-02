// The checkout's marketing consent checkbox (Settings → Customers →
// Marketing consent): shown unchecked, never required, with the merchant's
// label in the checkout language. Ticked, the form posts `marketingConsent`
// with the language the label was shown in; the order body then carries
// `marketingConsent: { language }` and the API records the consent after the
// order commits (it never blocks the order). Unticked, the body has no
// `marketingConsent` at all. Client-safe: the payment step's order builder
// imports it, so it pulls in no copy catalog.
import type { CheckoutConfig } from "@/lib/api/checkout";

export const MARKETING_CONSENT_FIELD = "marketingConsent";

export interface MarketingConsentCheckbox {
  label: string;
  /** The form value: the language the label is in (`en`, `bn`). */
  language: string;
}

/** The checkbox to show, or null when the store does not ask (or has no words for it). */
export function marketingConsentCheckbox(
  config: Pick<CheckoutConfig, "marketingConsent"> | null | undefined,
  languageCode: unknown,
): MarketingConsentCheckbox | null {
  const consent = config?.marketingConsent;
  if (!consent?.enabled || consent.channels.length === 0) return null;
  const language = typeof languageCode === "string" && /^bn(?:$|[-_])/i.test(languageCode.trim()) ? "bn" : "en";
  const label = consent.label[language]?.trim() || consent.label.en?.trim() || "";
  if (!label) return null;
  return { label, language: label === consent.label[language]?.trim() ? language : "en" };
}

const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/**
 * The order body's consent field from the posted checkbox value: present only
 * when it was ticked (any non-empty value), with its language when readable.
 */
export function marketingConsentOrderField(value: unknown): { marketingConsent?: { language: string | null } } {
  if (typeof value !== "string" || value.trim() === "") return {};
  const language = value.trim().toLowerCase();
  return { marketingConsent: { language: language.length <= 16 && LANGUAGE.test(language) ? language : null } };
}
