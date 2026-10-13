import { NEWSLETTER_MARKETING_COPY } from "@scalius/shared/customer-marketing";
// The newsletter signup form's model, shared by the homepage section, the
// newsletter-grey footer and the /newsletter page: which fields it asks for
// (the theme's newsletter section settings, else phone + optional e-mail),
// its words in the store's language, and where it posts. The form is a plain
// POST to the storefront endpoint (works without JavaScript); the endpoint
// answers a 303 to /newsletter with a status flag, or JSON for the script.
import type {
  StorefrontNewsletterEmailField,
  StorefrontSection,
  StorefrontSectionOf,
} from "@scalius/shared/storefront-theme";
import {
  isNewsletterStatus,
  newsletterCopy,
  type NewsletterCopy,
  type NewsletterLanguage,
  type NewsletterStatus,
} from "@/lib/newsletter-copy";

export const NEWSLETTER_SUBSCRIBE_ENDPOINT = "/api/newsletter/subscribe";
export const NEWSLETTER_RESULT_PATH = "/newsletter";
export const NEWSLETTER_CONFIRM_PATH = "/newsletter/confirm";
export const NEWSLETTER_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe";

type NewsletterSettings = StorefrontSectionOf<"newsletter">["settings"];

export interface NewsletterFormModel {
  language: NewsletterLanguage;
  copy: NewsletterCopy;
  heading: string;
  text: string;
  buttonLabel: string;
  /** How the form asks for the e-mail (the phone is always asked). */
  email: StorefrontNewsletterEmailField;
  /** The WhatsApp box for the same number. */
  whatsapp: boolean;
  /** The consent line under the form (the channels it subscribes). */
  consentLine: string;
}

/** The first newsletter section on the theme's homepage: the store's signup settings. */
export function themeNewsletterSettings(sections: readonly StorefrontSection[]): NewsletterSettings | null {
  const section = sections.find((each) => each.type === "newsletter");
  return section?.type === "newsletter" ? section.settings : null;
}

/** The form for these settings (none: phone and an optional e-mail) in the store's language. */
export function newsletterFormModel(
  settings: Partial<NewsletterSettings> | null | undefined,
  language: NewsletterLanguage,
): NewsletterFormModel {
  const copy = newsletterCopy(language);
  const email = settings?.email ?? "optional";
  return {
    language,
    copy,
    heading: settings?.heading?.trim() || copy.heading,
    text: settings?.text?.trim() || copy.text,
    buttonLabel: settings?.buttonLabel?.trim() || copy.button,
    email,
    whatsapp: settings?.whatsapp === true,
    consentLine: NEWSLETTER_MARKETING_COPY[language],
  };
}

/** Where a form post lands: the result page with only the outcome in the URL. */
export function newsletterResultPath(status: NewsletterStatus): string {
  return `${NEWSLETTER_RESULT_PATH}?${new URLSearchParams({ status })}`;
}

export function readNewsletterStatus(search: URLSearchParams): NewsletterStatus | null {
  const status = search.get("status");
  return isNewsletterStatus(status) ? status : null;
}
