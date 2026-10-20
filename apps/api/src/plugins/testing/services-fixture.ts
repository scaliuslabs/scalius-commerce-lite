// An app that provides the service ports (search, address autocomplete, FX
// rates, push, chat messaging), written without the SDK so the tests run
// the same bytes in the bundled loader: what each consumer gets through the
// plugin host, with both sides of each port validated.

import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";

export const SERVICES_FIXTURE_ID = "acme.services";

export const SERVICES_FIXTURE_MANIFEST = {
  id: SERVICES_FIXTURE_ID,
  name: "Acme Services",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Search, address, FX, push and chat providers for the provider tests.",
  author: { name: "Acme" },
  // Address suggestions carry the buyer's street; chat sends carry the phone (COMMERCE-HOOKS H5).
  scopes: ["read_customer_phones", "read_customer_addresses"],
  settings: [{ key: "api_key", label: "API key", type: "secret", required: true }],
  providers: {
    search: [{ id: "search", name: "Acme Search" }],
    address: [{ id: "places", name: "Acme Places", countries: ["BD"] }],
    fx: [{ id: "rates", name: "Acme Rates", operations: ["testConnection"] }],
    push: [{ id: "push", name: "Acme Push" }],
    messaging: [{ id: "chat", name: "Acme Chat", channels: ["whatsapp"] }],
  },
} as const;

/** The module source (ES module, no imports). */
export const SERVICES_FIXTURE_CODE = `
const manifest = ${JSON.stringify(SERVICES_FIXTURE_MANIFEST)};
export default {
  manifest,
  providers: {
    search: {
      kind: "search",
      async search(input) {
        if (input.query === "broken") return { productIds: "not a list" };
        return { productIds: ["prod_" + input.query, "prod_other"].slice(0, input.limit) };
      },
    },
    places: {
      kind: "address",
      async suggest(input) {
        return { suggestions: [{ id: "place_1", text: input.query + ", Dhanmondi", secondaryText: "Dhaka 1205" }] };
      },
      async resolve(input) {
        return { address: { countryCode: input.country, line1: "House 12, Road 5", locality: "Dhaka", postalCode: "1205" } };
      },
    },
    rates: {
      kind: "fx",
      async rates(input) {
        return { rates: input.quotes.map((currency) => ({ currency, rate: currency === "USD" ? "0.0084" : "1.25", asOf: "2026-10-08T06:00:00Z" })) };
      },
      async testConnection(_input, ctx) {
        return { ok: Boolean(ctx.settings.api_key), message: "Key saved." };
      },
    },
    push: {
      kind: "push",
      async send(input) {
        return { success: true, delivered: input.to.length, providerRef: "push-" + input.to[0] };
      },
    },
    chat: {
      kind: "messaging",
      async send(input) {
        if (input.to === "+8801700000000") {
          const error = new Error("The recipient has no WhatsApp account.");
          error.name = "ProviderError";
          error.category = "declined";
          throw error;
        }
        return { success: true, providerRef: "wamid-" + input.template.name };
      },
    },
  },
};
`;
