import { describe, expect, it } from "vitest";
import type { PluginSettingsSchema } from "../plugins/settings-schema";
import { compareThemeDocuments } from "./compare";
import { storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { storefrontSectionDefault, type StorefrontSection } from "./sections";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { storefrontThemeTextOf, storefrontThemeTranslationProblems, translateStorefrontTheme, type StorefrontThemeAppSchemas } from "./translate";
import type { StorefrontThemeTranslation } from "./text";

const hero: StorefrontSection = {
  ...storefrontSectionDefault("hero", "hero"),
  settings: {
    layout: "split",
    slides: [{ image: "media_1", focalPoint: { x: 50, y: 50 }, alt: "Eid sarees", heading: "Eid sale", buttonLabel: "Shop now", link: "/sale" }],
  },
  skin: { app: "acme.theme/hero", values: { eyebrow: "New season", tone: "soft" } },
};
const faq: StorefrontSection = {
  ...storefrontSectionDefault("faq", "faq"),
  settings: { heading: "Questions", items: [{ question: "Cash on delivery?", answer: "Yes, everywhere." }] },
};
const promo: StorefrontSection = {
  id: "promo", type: "app", version: 1,
  settings: { app: "acme.theme/promo", values: { heading: "Shop now", slides: [{ caption: "Eid sale", style: "Eid sale" }] } },
};

function theme(extra: Partial<StorefrontThemeDocument> = {}): StorefrontThemeDocument {
  return storefrontThemeDocumentSchema.parse({
    ...DEFAULT_STOREFRONT_THEME,
    blocks: {
      ...DEFAULT_STOREFRONT_THEME.blocks,
      topBar: { variant: "announcement", settings: { text: "Free delivery over ৳3,000", link: null } },
    },
    pages: {
      ...DEFAULT_STOREFRONT_THEME.pages,
      home: [hero, faq, promo],
      landing: { eid: { title: "Eid sale", description: "Every offer.", sections: [faq] } },
    },
    ...extra,
  });
}

const translations: StorefrontThemeTranslation[] = [
  { locale: "bn", marketId: null, fields: { "Eid sale": "ঈদ সেল", "Shop now": "এখনই কিনুন", "New season": "নতুন মৌসুম", "Questions": "প্রশ্ন", "Free delivery over ৳3,000": "৳৩,০০০ এর বেশি অর্ডারে ফ্রি ডেলিভারি" } },
  { locale: "bn", marketId: "mkt_in", fields: { "Eid sale": "ঈদের অফার" } },
  { locale: "en", marketId: null, fields: { "Questions": "FAQ" } },
];

const schemas: Record<string, PluginSettingsSchema> = {
  "skin:acme.theme/hero": [
    { key: "eyebrow", type: "text", label: "Eyebrow", required: false, maxLength: 40 },
    { key: "tone", type: "select", label: "Tone", required: false, options: [{ value: "soft", label: "Soft" }] },
  ],
  "section:acme.theme/promo": [
    { key: "heading", type: "text", label: "Heading", required: false, maxLength: 4 },
    {
      key: "slides", type: "list", label: "Slides", required: false, min: 0, max: 4,
      fields: [
        { key: "caption", type: "textarea", label: "Caption", required: false, maxLength: 200 },
        { key: "style", type: "select", label: "Style", required: false, options: [{ value: "Eid sale", label: "Eid" }] },
      ],
    },
  ],
};
const apps: StorefrontThemeAppSchemas = (kind, key) => schemas[`${kind}:${key}`] ?? null;

describe("theme text in the page's language", () => {
  it("orders a document's rows by the one fallback chain", () => {
    const document = theme({ translations });
    const at = (locale: string, marketId: string | null) => storefrontThemeTextOf(document, { locale, marketId, defaultLocale: "en" });
    expect(at("bn", "mkt_in")!("Eid sale")).toBe("ঈদের অফার");
    expect(at("bn", null)!("Eid sale")).toBe("ঈদ সেল");
    // The default locale's row is the last fallback, then the source words.
    expect(at("bn", null)!("Questions")).toBe("প্রশ্ন");
    expect(at("fr", null)!("Questions")).toBe("FAQ");
    expect(at("fr", null)!("Untranslated")).toBe("Untranslated");
    expect(storefrontThemeTextOf(theme(), { locale: "bn", marketId: null, defaultLocale: "en" })).toBeNull();
    expect(storefrontThemeTextOf(document, null)).toBeNull();
  });

  it("replaces the declared words everywhere and serves the document without its translations", () => {
    const document = theme({ translations });
    const text = storefrontThemeTextOf(document, { locale: "bn", marketId: null, defaultLocale: "en" });
    const translated = translateStorefrontTheme(document, text, apps);
    expect(translated.translations).toBeUndefined();
    const [slideHero, questions, app] = translated.pages.home as [Extract<StorefrontSection, { type: "hero" }>, Extract<StorefrontSection, { type: "faq" }>, Extract<StorefrontSection, { type: "app" }>];
    expect(slideHero.settings.slides[0]).toMatchObject({ heading: "ঈদ সেল", buttonLabel: "এখনই কিনুন", alt: "Eid sarees", link: "/sale" });
    // A skin's text settings follow its schema: a choice is never text.
    expect(slideHero.skin!.values).toEqual({ eyebrow: "নতুন মৌসুম", tone: "soft" });
    expect(questions.settings.heading).toBe("প্রশ্ন");
    expect(questions.settings.items[0]!.question).toBe("Cash on delivery?");
    // An app section's text within its own maxLength, list text fields included; choices stay.
    expect(app.settings.values).toEqual({ heading: "Shop now", slides: [{ caption: "ঈদ সেল", style: "Eid sale" }] });
    expect(translated.pages.landing.eid!.title).toBe("ঈদ সেল");
    expect((translated.blocks.topBar.settings as { text: string }).text).toBe("৳৩,০০০ এর বেশি অর্ডারে ফ্রি ডেলিভারি");
    // Without a schema (an app that is gone) its values stay as stored.
    expect((translateStorefrontTheme(document, text).pages.home[2] as typeof app).settings.values).toEqual(promo.settings.values);
  });

  it("returns the stored document unchanged where nothing applies", () => {
    const plain = theme();
    expect(translateStorefrontTheme(plain, null)).toBe(plain);
    const document = theme({ translations });
    expect(translateStorefrontTheme(document, null)).toEqual(plain);
    expect(translateStorefrontTheme(plain, () => "x".repeat(400))).toBe(plain);
  });

  it("refuses a translation that does not fit its place on save, and serves the source words if one is stored", () => {
    const long = theme({ translations: [{ locale: "bn", marketId: null, fields: { "Questions": "প".repeat(121) } }] });
    expect(storefrontThemeTranslationProblems(long)).toEqual([
      { path: "translations.0.fields", message: expect.stringMatching(/^A bn translation does not fit at pages\.home\.1\.settings\.heading: /) },
    ]);
    expect(storefrontThemeTranslationProblems(theme({ translations }))).toEqual([]);
    const text = storefrontThemeTextOf(long, { locale: "bn", marketId: null, defaultLocale: "en" });
    expect(translateStorefrontTheme(long, text)).toEqual(theme());
  });

  it("records a translations change as its own area", () => {
    expect(compareThemeDocuments(theme(), theme({ translations }))).toEqual([{ kind: "settings-changed", area: "translations" }]);
  });

  it("keeps one row per language and market", () => {
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme(), translations: [translations[0], translations[0]] }).success).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme(), translations: [{ locale: "bengali", marketId: null, fields: {} }] }).success).toBe(false);
  });
});
