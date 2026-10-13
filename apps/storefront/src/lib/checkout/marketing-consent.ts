// Independent optional channel choices survive both hydrated and plain form posts.
import { MARKETING_CONTACT_CHANNELS, type MarketingConsentSettings } from "@scalius/shared/customer-marketing";
import type { CheckoutConfig } from "@/lib/api/checkout";
export const MARKETING_CONSENT_FIELD = "marketingConsent";
type ContactChannel = MarketingConsentSettings["checkout"]["channels"][number];
export interface MarketingConsentCheckbox { label: string; language: "en" | "bn"; channels: ContactChannel[] }
export function marketingConsentCheckbox(config: Pick<CheckoutConfig, "marketingConsent"> | null | undefined, languageCode: unknown): MarketingConsentCheckbox | null {
  const consent = config?.marketingConsent;
  if (!consent?.enabled || consent.channels.length === 0) return null;
  const language = typeof languageCode === "string" && /^bn(?:$|[-_])/i.test(languageCode.trim()) ? "bn" : "en";
  const label = consent.label[language]?.trim() || consent.label.en?.trim() || "";
  return label ? { label, language: label === consent.label[language]?.trim() ? language : "en", channels: MARKETING_CONTACT_CHANNELS.filter((channel) => consent.channels.includes(channel)) } : null;
}
export function marketingConsentOrderField(input: unknown): { marketingConsent?: { language: "en" | "bn"; channels: ContactChannel[] } } {
  if (!input || typeof input !== "object") return {};
  const read = (name: string) => input instanceof FormData ? input.get(name) : (input as Record<string, unknown>)[name];
  const channels = MARKETING_CONTACT_CHANNELS.filter((channel) => read(`${MARKETING_CONSENT_FIELD}_${channel}`) === "en" || read(`${MARKETING_CONSENT_FIELD}_${channel}`) === "bn");
  if (!channels.length) return {};
  return { marketingConsent: { language: read(`${MARKETING_CONSENT_FIELD}_${channels[0]}`) === "bn" ? "bn" : "en", channels } };
}
export function marketingConsentFormValues(input: unknown): Record<string, string> {
  const consent = marketingConsentOrderField(input).marketingConsent;
  return consent ? Object.fromEntries(consent.channels.map((channel) => [`${MARKETING_CONSENT_FIELD}_${channel}`, consent.language])) : {};
}
