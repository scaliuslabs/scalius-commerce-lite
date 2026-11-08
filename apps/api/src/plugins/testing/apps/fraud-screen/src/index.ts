// Fraud screen (`acme.fraud-screen`): blocks a checkout whose phone or email
// the merchant has flagged, before the order exists. Proves contact facts in
// `cart.validate`: the app asks for `read_customer_phones` and
// `read_customer_emails`, so its input's `contact.phone` and `contact.email`
// carry the buyer's; the name and street stay null (no scope for them), and
// an app without these scopes reads them null too.
//
// `contact` is null where checkout has no contact yet (the cart page, a
// quote): the screen then lets the cart through and decides at placement.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.fraud-screen",
  name: "Fraud screen",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Stops checkout for phone numbers and email domains you have flagged.",
  author: { name: "Scalius" },
  tagline: "Stop flagged buyers at checkout",
  categories: ["checkout", "compliance"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  scopes: ["read_customer_phones", "read_customer_emails"],
  functions: [{ point: "cart.validate", priority: 10 }],
  settings: [
    { key: "phones", label: "Flagged phone numbers", type: "text", maxLength: 500, help: "Comma-separated, as buyers type them (+8801…)." },
    { key: "email_domains", label: "Flagged email domains", type: "text", maxLength: 500, help: "Comma-separated (example.test)." },
    { key: "message", label: "Message to the buyer", type: "text", maxLength: 200, default: "We can't take this order online. Please contact the store." },
  ],
  translations: {
    bn: {
      name: "ফ্রড স্ক্রিন",
      tagline: "চিহ্নিত ক্রেতাদের চেকআউটে থামান",
      description: "আপনার চিহ্নিত ফোন নম্বর ও ইমেইল ডোমেইনের জন্য চেকআউট বন্ধ রাখে।",
    },
  },
} satisfies PluginManifestInput;

/** A comma-separated setting as a list of trimmed, lower-case entries. */
export function listSetting(value: unknown): string[] {
  return String(value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

const digits = (phone: string) => phone.replace(/[^0-9]/g, "");

export default definePlugin({
  manifest,

  functions: {
    "cart.validate": ({ contact }, settings) => {
      if (!contact) return { errors: [] };
      const phones = new Set(listSetting(settings.phones).map(digits));
      const domains = new Set(listSetting(settings.email_domains));
      const phoneFlagged = Boolean(contact.phone && phones.has(digits(contact.phone)));
      const domain = contact.email?.split("@")[1]?.toLowerCase() ?? null;
      const emailFlagged = Boolean(domain && domains.has(domain));
      if (!phoneFlagged && !emailFlagged) return { errors: [] };
      const message = String(settings.message ?? "").trim().slice(0, 200) || "We can't take this order online. Please contact the store.";
      return { errors: [{ code: "fraud_flagged", message }] };
    },
  },
});
