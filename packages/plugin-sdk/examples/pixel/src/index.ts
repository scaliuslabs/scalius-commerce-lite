// acme.pixel: the pixel test app (packages/plugin-sdk/docs/storefront.md,
// "Pixels"). An analytics vendor's pixel on the stable app API only: it hears
// every buyer event on every page, checkout and the receipt included, once
// the buyer allows marketing, and sends each to its collector with the
// merchant's account id (a public setting; the API key is a secret it never
// gets in the browser). It may see a buyer's email (read_customer_emails),
// never their phone, name or street.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.pixel",
  name: "Acme Pixel",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sends what buyers do on your store to Acme Analytics.",
  author: { name: "Acme" },
  categories: ["marketing"],
  scopes: ["read_customer_emails"],
  settings: [
    { key: "account_id", label: "Account id", type: "text", default: "", maxLength: 40 },
    { key: "api_key", label: "API key", type: "secret" },
  ],
  storefront: {
    pixel: { consent: "marketing", settings: ["account_id"] },
    connect: ["collect.acme.example"],
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
