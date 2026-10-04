// @vitest-environment node
/**
 * The checkout phone field's server render (components/CheckoutPhoneField.astro):
 * a store that sells only to Bangladesh renders the field byte for byte as it
 * did before foreign countries (CheckoutPhoneField.golden.json, captured from
 * the component at 3904de6ce), and a store that sells abroad starts the field
 * in the address form's country with that country's hint and example.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA as copy,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import golden from "./CheckoutPhoneField.golden.json";

const root = fileURLToPath(new URL("../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(component: unknown, options: { props?: object }): Promise<string>;
}

let server: ViteDevServer;
let container: Container;
let Field: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "phone-field-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0phone-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0phone-test:") ? VIRTUAL_MODULES[id.slice("\0phone-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  Field = (await server.ssrLoadModule("/src/components/CheckoutPhoneField.astro")).default;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const window = new Window();

function props(language: CheckoutLanguageData = copy) {
  return {
    label: language.customerPhoneLabel,
    help: language.customerPhoneHelp,
    pickupHelp: language.customerPhonePickupHelp,
    serviceHelp: language.customerPhoneServiceHelp,
    placeholder: language.customerPhonePlaceholder,
    requiredMessage: language.phoneRequiredText,
    invalidMessage: language.phoneIntlInvalidText,
    mobileMessage: language.phoneInvalidText,
    countryNotAcceptedMessage: language.phoneCountryNotAcceptedText,
    countrySelectLabel: language.phoneCountryLabelText,
    languageCode: language === copy ? "en" : "bn",
  };
}

/** What the cart page passes since foreign countries: the store's countries, the form's, and the foreign hint copy. */
function withCountries(language: CheckoutLanguageData, shippingCountries: string[], shippingCountry: string) {
  return {
    ...props(language),
    shippingCountries,
    shippingCountry,
    intl: {
      help: language.customerPhoneIntlHelp,
      pickupHelp: language.customerPhoneIntlPickupHelp,
      serviceHelp: language.customerPhoneIntlServiceHelp,
      exampleText: language.customerPhoneExampleText,
    },
  };
}

async function render(properties: object) {
  const html = await container.renderToString(Field, { props: properties });
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const field = doc.getElementById("customerPhone-field")!;
  return {
    html,
    field,
    badge: field.querySelector("[data-phone-box] > span")?.textContent?.trim(),
    sentences: [...doc.querySelectorAll("#customerPhone-help > span")].map((span) => span.textContent),
    placeholder: doc.getElementById("customerPhone-input")?.getAttribute("placeholder"),
  };
}

describe("a store that sells only to Bangladesh", () => {
  // Its accepted countries always name Bangladesh (the markets add it to the merchant's list).
  const cases = [
    ["a Bangladesh-only policy", { allowedCountries: ["BD"], allowedCountriesMode: "include" }, "bdOnly"],
    ["no policy", { allowedCountries: [], allowedCountriesMode: "include" }, "open"],
  ] as const;

  it.each(cases)("renders %s byte for byte as before", async (_name, policy, key) => {
    const { html } = await render({ ...withCountries(copy, ["BD"], "BD"), ...policy });
    expect(html).toBe(golden[key]);
  });

  it("changes no byte when the new props are left out, even for a policy that refuses Bangladesh", async () => {
    for (const [policy, key] of [
      [{ allowedCountries: ["BD"], allowedCountriesMode: "include" }, "bdOnly"],
      [{ allowedCountries: [], allowedCountriesMode: "include" }, "open"],
      [{ allowedCountries: ["BD"], allowedCountriesMode: "exclude" }, "exclude"],
    ] as const) {
      expect((await render({ ...props(), ...policy })).html, key).toBe(golden[key]);
    }
  });
});

describe("a store that sells abroad", () => {
  const policy = { allowedCountries: ["BD", "IN"], allowedCountriesMode: "include" } as const;

  it("starts in the address form's country: its code, its example and a hint that asks for the country code", async () => {
    const india = await render({ ...withCountries(copy, ["BD", "IN"], "IN"), ...policy });

    expect(india.field.getAttribute("data-default-country")).toBe("IN");
    expect(india.field.getAttribute("data-countries")).toBe("BD,IN");
    expect(india.field.getAttribute("data-country-mode")).toBe("include");
    expect(india.badge).toBe("+91");
    expect(india.sentences).toEqual([
      "Include your country code. The courier calls this number. Example: +91 81234 56789",
      "Include your country code. We call this number when your order is ready to pick up. Example: +91 81234 56789",
      "Include your country code. We send your order updates to this number. Example: +91 81234 56789",
    ]);
    expect(india.placeholder).toBe("081234 56789");
    expect(JSON.parse(india.field.getAttribute("data-phone-countries")!)).toEqual({
      IN: { code: "+91", example: "+91 81234 56789", national: "081234 56789" },
    });
    // The picker is there (two accepted countries).
    expect(india.field.querySelector("[data-phone-country]")).not.toBeNull();
  });

  it("keeps the Bangladesh copy on a Bangladesh page, with the other country's facts ready for the script", async () => {
    const bangladesh = await render({ ...withCountries(copy, ["BD", "IN"], "BD"), ...policy });

    expect(bangladesh.field.getAttribute("data-default-country")).toBe("BD");
    expect(bangladesh.badge).toBe("BD");
    expect(bangladesh.sentences).toEqual([
      copy.customerPhoneHelp,
      copy.customerPhonePickupHelp,
      copy.customerPhoneServiceHelp,
    ]);
    expect(bangladesh.placeholder).toBe("01712-345678");
    expect(bangladesh.field.getAttribute("data-phone-countries")).not.toBeNull();
  });

  it("speaks the checkout language", async () => {
    const india = await render({ ...withCountries(BANGLA_CHECKOUT_LANGUAGE_DATA, ["BD", "IN"], "IN"), ...policy });

    expect(india.sentences[0]).toBe("কান্ট্রি কোডসহ নম্বর লিখুন। কুরিয়ার এই নম্বরে কল করবে। উদাহরণ: +91 81234 56789");
  });

  it("starts in Bangladesh when the store does not accept numbers from the form's country", async () => {
    const refused = await render({
      ...withCountries(copy, ["BD", "IN"], "IN"),
      allowedCountries: ["BD"],
      allowedCountriesMode: "include",
    });

    expect(refused.field.getAttribute("data-default-country")).toBe("BD");
    expect(refused.badge).toBe("BD");
    expect(refused.sentences[0]).toBe(copy.customerPhoneHelp);
  });

  it("starts in a store that sells only abroad in that country, behind a picker that still offers Bangladesh", async () => {
    const indiaOnly = await render({ ...withCountries(copy, ["IN"], "IN"), ...policy });

    expect(indiaOnly.field.getAttribute("data-default-country")).toBe("IN");
    expect(indiaOnly.badge).toBe("+91");
    expect(indiaOnly.field.querySelector("[data-phone-country]")).not.toBeNull();
  });
});
