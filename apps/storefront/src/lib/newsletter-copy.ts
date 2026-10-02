// The newsletter's words in the store's language (English and Bangla): the
// signup form (homepage section, footer, /newsletter), its consent line, the
// result page, the e-mail confirmation and unsubscribe pages, and the
// account's marketing preferences. The language is the active checkout
// language's base code (the layout's `storefrontCopy.languageCode`, or the
// checkout language read), so the newsletter speaks like the rest of the
// store. A merchant's own heading, text or button label replaces the default.
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import type { MarketingChannel } from "@scalius/shared/customer-marketing";

export type NewsletterLanguage = "en" | "bn";

/**
 * Outcomes the result page (`/newsletter?status=…`) shows. Only this enum
 * ever enters a URL: never a phone, an e-mail or a token.
 */
export const NEWSLETTER_STATUSES = [
  "subscribed",
  "pending",
  "invalid",
  "rate_limited",
  "error",
  "confirmed",
  "unsubscribed",
  "link_invalid",
] as const;
export type NewsletterStatus = (typeof NEWSLETTER_STATUSES)[number];

export function isNewsletterStatus(value: unknown): value is NewsletterStatus {
  return typeof value === "string" && (NEWSLETTER_STATUSES as readonly string[]).includes(value);
}

/** The store language the newsletter speaks: Bangla for `bn…`, else English. */
export function newsletterLanguage(code: unknown): NewsletterLanguage {
  return checkoutLanguageBaseCode(code) === "bn" ? "bn" : "en";
}

export interface NewsletterStatusCopy {
  title: string;
  text: string;
}

export interface NewsletterCopy {
  heading: string;
  text: string;
  phoneLabel: string;
  phonePlaceholder: string;
  emailLabel: string;
  emailOptionalLabel: string;
  emailPlaceholder: string;
  /** The WhatsApp box (its own consent, for the same number). */
  whatsappLabel: string;
  button: string;
  sending: string;
  /** The consent line under the form: the channels the form subscribes. */
  consent: (channels: { email: boolean }) => string;
  status: Record<NewsletterStatus, NewsletterStatusCopy>;
  /** The result page's heading when it shows the form alone. */
  pageTitle: string;
  continueShopping: string;
  channelName: Record<MarketingChannel, string>;
  confirmTitle: string;
  confirmText: string;
  confirmButton: string;
  unsubscribeTitle: string;
  unsubscribeQuestion: (input: { channel: string; contact: string }) => string;
  unsubscribeAlready: (input: { channel: string; contact: string }) => string;
  unsubscribeButton: string;
  unsubscribeNote: string;
  /** The answer to a mail client's one-click unsubscribe (plain text). */
  oneClickDone: string;
  oneClickInvalid: string;
  account: {
    heading: string;
    text: string;
    channelLabel: Record<MarketingChannel, string>;
    pending: string;
    needsEmail: string;
    needsPhone: string;
    save: string;
    saved: string;
    confirmRequested: string;
    failed: string;
  };
}

const ENGLISH: NewsletterCopy = {
  heading: "Get news and offers",
  text: "New arrivals, sales and offers, sent to your phone first.",
  phoneLabel: "Phone number",
  phonePlaceholder: "01XXXXXXXXX",
  emailLabel: "Email",
  emailOptionalLabel: "Email (optional)",
  emailPlaceholder: "you@example.com",
  whatsappLabel: "Also send offers to this number on WhatsApp",
  button: "Subscribe",
  sending: "Subscribing…",
  consent: ({ email }) => `Get news and offers by ${email ? "SMS and email" : "SMS"}. Unsubscribe anytime.`,
  status: {
    subscribed: {
      title: "You're subscribed",
      text: "We'll send news and offers to your phone. You can unsubscribe anytime.",
    },
    pending: {
      title: "Check your email",
      text: "Your phone number is subscribed. To get offers by email too, tap the link in the email we just sent.",
    },
    invalid: {
      title: "Check your details",
      text: "Enter a valid phone number, and a valid email if you add one.",
    },
    rate_limited: {
      title: "Too many tries",
      text: "Please wait a minute, then try again.",
    },
    error: {
      title: "Something went wrong",
      text: "We couldn't save that. Please try again.",
    },
    confirmed: {
      title: "Your email is confirmed",
      text: "You'll get news and offers by email. You can unsubscribe anytime.",
    },
    unsubscribed: {
      title: "You're unsubscribed",
      text: "You won't get these messages any more. Order and delivery updates still reach you.",
    },
    link_invalid: {
      title: "This link no longer works",
      text: "It may have expired or been used already.",
    },
  },
  pageTitle: "Newsletter",
  continueShopping: "Continue shopping",
  channelName: { email: "email", sms: "SMS", whatsapp: "WhatsApp" },
  confirmTitle: "Confirm your subscription",
  confirmText: "Tap the button to get news and offers by email.",
  confirmButton: "Confirm subscription",
  unsubscribeTitle: "Unsubscribe",
  unsubscribeQuestion: ({ channel, contact }) => `Stop ${channel} messages to ${contact}?`,
  unsubscribeAlready: ({ channel, contact }) => `${contact} doesn't get ${channel} messages from us.`,
  unsubscribeButton: "Unsubscribe",
  unsubscribeNote: "Order and delivery updates are not affected.",
  oneClickDone: "You're unsubscribed.",
  oneClickInvalid: "This unsubscribe link is not valid.",
  account: {
    heading: "News and offers",
    text: "Choose how we may send you news and offers. Order and delivery updates always reach you.",
    channelLabel: { email: "Email", sms: "SMS", whatsapp: "WhatsApp" },
    pending: "Waiting for you to confirm by email.",
    needsEmail: "Add an email to your account to get offers by email.",
    needsPhone: "Add a phone number to your account first.",
    save: "Save preferences",
    saved: "Preferences saved.",
    confirmRequested: "Preferences saved. Check your email and tap the link to confirm.",
    failed: "We couldn't save your preferences. Please try again.",
  },
};

const BANGLA: NewsletterCopy = {
  heading: "নতুন খবর ও অফার পান",
  text: "নতুন পণ্য, সেল আর অফারের খবর সবার আগে আপনার মোবাইলে।",
  phoneLabel: "মোবাইল নম্বর",
  phonePlaceholder: "01XXXXXXXXX",
  emailLabel: "ইমেইল",
  emailOptionalLabel: "ইমেইল (ঐচ্ছিক)",
  emailPlaceholder: "you@example.com",
  whatsappLabel: "এই নম্বরে হোয়াটসঅ্যাপেও অফার পাঠান",
  button: "সাবস্ক্রাইব করুন",
  sending: "সাবস্ক্রাইব হচ্ছে…",
  consent: ({ email }) => `${email ? "এসএমএস ও ইমেইলে" : "এসএমএসে"} নতুন খবর ও অফার পাবেন। যেকোনো সময় আনসাবস্ক্রাইব করতে পারবেন।`,
  status: {
    subscribed: {
      title: "সাবস্ক্রাইব হয়েছে",
      text: "আপনার মোবাইলে নতুন খবর ও অফার পাঠানো হবে। যেকোনো সময় আনসাবস্ক্রাইব করতে পারবেন।",
    },
    pending: {
      title: "আপনার ইমেইল দেখুন",
      text: "আপনার মোবাইল নম্বর সাবস্ক্রাইব হয়েছে। ইমেইলেও অফার পেতে আমাদের পাঠানো ইমেইলের লিংকে ট্যাপ করুন।",
    },
    invalid: {
      title: "তথ্য আবার দেখুন",
      text: "সঠিক মোবাইল নম্বর দিন। ইমেইল দিলে সেটিও সঠিক হতে হবে।",
    },
    rate_limited: {
      title: "অনেকবার চেষ্টা করা হয়েছে",
      text: "এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।",
    },
    error: {
      title: "কিছু একটা সমস্যা হয়েছে",
      text: "সেভ করা যায়নি। আবার চেষ্টা করুন।",
    },
    confirmed: {
      title: "ইমেইল নিশ্চিত হয়েছে",
      text: "এখন থেকে ইমেইলে নতুন খবর ও অফার পাবেন। যেকোনো সময় আনসাবস্ক্রাইব করতে পারবেন।",
    },
    unsubscribed: {
      title: "আনসাবস্ক্রাইব হয়েছে",
      text: "আপনাকে আর এই বার্তা পাঠানো হবে না। অর্ডার ও ডেলিভারির খবর আগের মতোই পাবেন।",
    },
    link_invalid: {
      title: "লিংকটি আর কাজ করছে না",
      text: "লিংকটির মেয়াদ শেষ হয়ে গেছে বা আগেই ব্যবহার করা হয়েছে।",
    },
  },
  pageTitle: "নিউজলেটার",
  continueShopping: "কেনাকাটা চালিয়ে যান",
  channelName: { email: "ইমেইল", sms: "এসএমএস", whatsapp: "হোয়াটসঅ্যাপ" },
  confirmTitle: "সাবস্ক্রিপশন নিশ্চিত করুন",
  confirmText: "ইমেইলে নতুন খবর ও অফার পেতে নিচের বাটনে ট্যাপ করুন।",
  confirmButton: "সাবস্ক্রিপশন নিশ্চিত করুন",
  unsubscribeTitle: "আনসাবস্ক্রাইব",
  unsubscribeQuestion: ({ channel, contact }) => `${contact}-এ ${channel} বার্তা পাঠানো বন্ধ করবেন?`,
  unsubscribeAlready: ({ channel, contact }) => `${contact}-এ আমরা ${channel} বার্তা পাঠাই না।`,
  unsubscribeButton: "আনসাবস্ক্রাইব করুন",
  unsubscribeNote: "অর্ডার ও ডেলিভারির খবর বন্ধ হবে না।",
  oneClickDone: "আনসাবস্ক্রাইব হয়েছে।",
  oneClickInvalid: "এই আনসাবস্ক্রাইব লিংকটি সঠিক নয়।",
  account: {
    heading: "নতুন খবর ও অফার",
    text: "কোন মাধ্যমে নতুন খবর ও অফার পাবেন তা বেছে নিন। অর্ডার ও ডেলিভারির খবর সবসময় পাবেন।",
    channelLabel: { email: "ইমেইল", sms: "এসএমএস", whatsapp: "হোয়াটসঅ্যাপ" },
    pending: "ইমেইলে নিশ্চিত করার অপেক্ষায়।",
    needsEmail: "ইমেইলে অফার পেতে আপনার অ্যাকাউন্টে একটি ইমেইল যোগ করুন।",
    needsPhone: "আগে আপনার অ্যাকাউন্টে একটি মোবাইল নম্বর যোগ করুন।",
    save: "পছন্দ সেভ করুন",
    saved: "পছন্দ সেভ হয়েছে।",
    confirmRequested: "পছন্দ সেভ হয়েছে। নিশ্চিত করতে আপনার ইমেইলের লিংকে ট্যাপ করুন।",
    failed: "পছন্দ সেভ করা যায়নি। আবার চেষ্টা করুন।",
  },
};

const COPY: Record<NewsletterLanguage, NewsletterCopy> = { en: ENGLISH, bn: BANGLA };

export function newsletterCopy(language: NewsletterLanguage): NewsletterCopy {
  return COPY[language];
}

/**
 * The consent the buyer gave, as the form showed it: the consent line for
 * the channels the form offered, plus the WhatsApp box's words when ticked.
 * This exact text is stored with the consent record.
 */
export function newsletterConsentText(
  language: NewsletterLanguage,
  input: { emailOffered: boolean; whatsapp: boolean },
): string {
  const copy = COPY[language];
  const line = copy.consent({ email: input.emailOffered });
  return input.whatsapp ? `${line} ${copy.whatsappLabel}${language === "bn" ? "।" : "."}` : line;
}
