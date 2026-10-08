import { describe, expect, it } from "vitest";
import v1 from "./fixtures/v1.json";
import v2 from "./fixtures/v2.json";
import v3 from "./fixtures/v3.json";
import v4 from "./fixtures/v4.json";
import v5 from "./fixtures/v5.json";
import v6 from "./fixtures/v6.json";
import v7 from "./fixtures/v7.json";
import v8 from "./fixtures/v8.json";
import v9 from "./fixtures/v9.json";
import partialV1 from "./fixtures/v1-partial.json";
import colorsV1 from "./fixtures/v1-colors.json";
import {
  DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE, STOREFRONT_THEME_DOCUMENT_VERSION, homeSectionRequests, homeSectionsShowDeliveryFacts,
  parseStoredStorefrontThemeDocument, resolveStorefrontTheme, storefrontSectionDefault, STOREFRONT_TEMPLATE_IDS,
  storefrontThemeDocumentSchema, upgradeThemeDocument, listStorefrontThemeDocumentContrastProblems, storefrontThemeContrast,
  STOREFRONT_THEME_PALETTES, type StorefrontThemeDocument,
} from "../storefront-theme";

const goldenFixtures = [v1, v2, v3, v4, v5, v6, v7, v8, v9];
const fixture = (version: number) => JSON.parse(JSON.stringify(goldenFixtures[version - 1]));
type Section = { id: string; settings: Record<string, unknown> };

describe("step-wise stored theme upgrades", () => {
  it("has a golden fixture for every version, the current one included", () => {
    expect(goldenFixtures).toHaveLength(STOREFRONT_THEME_DOCUMENT_VERSION);
    goldenFixtures.forEach((each, index) => expect((each as { version: number }).version).toBe(index + 1));
    // The current fixture is a valid document as stored; a future step reads it.
    expect(storefrontThemeDocumentSchema.safeParse(fixture(STOREFRONT_THEME_DOCUMENT_VERSION)).success).toBe(true);
  });

  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    it(`upgrades the golden v${version} fixture to a valid current document, keeping merchant content and the input`, () => {
      const stored = fixture(version);
      const before = structuredClone(stored);
      const upgraded = upgradeThemeDocument(stored);
      expect(stored).toEqual(before);
      expect(storefrontThemeDocumentSchema.safeParse(upgraded).success).toBe(true);
      expect(upgraded.version).toBe(STOREFRONT_THEME_DOCUMENT_VERSION);
      expect(upgradeThemeDocument(upgraded)).toEqual(upgraded);
      expect(parseStoredStorefrontThemeDocument(JSON.stringify(stored))).toEqual(upgraded);
      // Colours: the merchant's primary survives every step.
      expect(upgraded.tokens.colors.primary).toBe("#123456");
      // Fonts: independent v1/v2 fonts map to the pairing that matches them.
      expect(upgraded.tokens.typography).toBe(version === 1 ? "retail" : "heritage");
      if (version >= 4) {
        // The stored v4 to v8 card is the portrait look, whose photo ratio, fit and surface already are the stored tokens.
        expect(upgraded.tokens).toEqual(stored.tokens);
        expect(upgraded.template).toBe("boutique");
        expect(upgraded.blocks.card).toEqual({ variant: "standard", settings: { facts: "none", action: "none", hoverImage: true } });
        expect(upgraded.pages.home.map((section) => section.id)).toEqual(stored.pages.home.map((section: Section) => section.id));
        // Copy and images: a stored banner's settings come through exactly.
        const banner = (sections: readonly Section[]) => sections.find((section) => section.id === "merchant-banner")?.settings;
        expect(banner(upgraded.pages.home as Section[])).toEqual(banner(stored.pages.home));
      }
      if (version >= 6) {
        // Stored block settings win over today's defaults (v6 retired a few never-rendered ones).
        for (const slot of ["header", "footer"] as const) {
          expect(upgraded.blocks[slot].settings).toMatchObject(stored.blocks[slot].settings);
        }
      }
      if (version >= 2) expect(upgraded.pages.home.find((section) => section.id === "merchant-story")).toMatchObject({
        type: "editorial", settings: { layout: "rich-text", heading: "আমাদের গল্প", body: "Made in Rajshahi. নিজের হাতে তৈরি।" },
      });
      if (version >= 6) {
        expect(upgraded.brand).toEqual(stored.brand);
        expect(upgraded.pages.home[0]).toEqual(stored.pages.home[0]);
      }
      if (version === STOREFRONT_THEME_DOCUMENT_VERSION) expect(upgraded).toEqual(stored);
      else expect(storefrontThemeDocumentSchema.safeParse(stored).success).toBe(false);
    });
  }

  it("recognizes the actual unversioned pre-v2 semantic shape", () => {
    const legacy = fixture(1);
    delete legacy.version;
    expect(upgradeThemeDocument(legacy)).toEqual(upgradeThemeDocument(fixture(1)));
  });

  it("enriches partial semantic settings with historical defaults and preserves supplied choices", () => {
    const partial = structuredClone(partialV1);
    const before = structuredClone(partial);
    const theme = upgradeThemeDocument(partial);
    expect(partial).toEqual(before);
    expect(theme.tokens).toMatchObject({ typography: "editorial", typeScale: "display", radius: "rounded", density: "airy", surface: "flat", container: "1440" });
    expect(theme.tokens.colors).toMatchObject({ primary: "#123456", "primary-foreground": "#ffffff", border: "#123456", background: "#ffffff", foreground: "#18181b" });
    expect(theme.blocks.footer.variant).toBe("support-dark");
    expect(theme.pages.home.map((section) => section.id)).toEqual(["delivery", "hero", "categories", "collections"]);
    expect(parseStoredStorefrontThemeDocument(JSON.stringify(partial))).toEqual(theme);
  });

  it("upgrades the original flat colour map while preserving overrides", () => {
    const colors = structuredClone(colorsV1);
    const theme = upgradeThemeDocument(colors);
    expect(theme.tokens.colors).toMatchObject({ primary: "#123456", "primary-foreground": "#ffffff", border: "#aabbcc", foreground: "#18181b" });
    expect(theme.tokens).toMatchObject({ typography: "retail", density: "comfortable", radius: "subtle", container: "1440", surface: "hairline" });
    expect(theme.pages.home.map((section) => section.id)).toEqual(["hero", "collections", "categories", "delivery"]);
    expect(storefrontThemeDocumentSchema.safeParse(colors).success).toBe(false);
    for (const invalid of [
      { ...colors, unknown: "#ffffff" }, { colors, typography: { heading: "unknown" } },
      { colors, layout: { unknown: true } }, { colors, components: { cards: "unknown" } },
      { colors: { primary: "var(--unknown)" } }, { colors: { primary: "var(--primary)" } },
    ]) expect(parseStoredStorefrontThemeDocument(JSON.stringify(invalid))).toBeNull();
  });

  it("preserves legacy opaque CSS colours as equivalent hex, instead of dropping overrides", () => {
    for (const color of ["#123", "rgb(17, 34, 51)", "hsl(210 50% 13.333333%)"]) {
      const legacy = fixture(1);
      legacy.colors.primary = color;
      expect(upgradeThemeDocument(legacy).tokens.colors.primary).toBe("#112233");
    }
    for (const [color, expected] of [["lab(20% 0 0)", "#303030"], ["lch(20% 0 230)", "#303030"], ["oklab(20% 0 0)", "#161616"], ["oklch(20% 0 120)", "#161616"]]) {
      const legacy = fixture(1);
      legacy.colors.primary = color;
      expect(upgradeThemeDocument(legacy).tokens.colors.primary, color).toBe(expected);
    }
    for (const [color, expected] of [["#0008", "#777777"], ["#00000080", "#7f7f7f"], ["rgb(0 0 0 / 50%)", "#808080"], ["transparent", "#ffffff"]]) {
      const legacy = fixture(1);
      legacy.colors.border = color;
      expect(upgradeThemeDocument(legacy).tokens.colors.border, color).toBe(expected);
    }
  });

  it("maps every pre-v3 font choice to the pairing with the same faces", () => {
    const pairing = (heading: string, body: string) => {
      const legacy = fixture(2);
      legacy.tokens.typography = { heading, body };
      return upgradeThemeDocument(legacy).tokens.typography;
    };
    expect(pairing("editorial", "humanist")).toBe("heritage");
    expect(pairing("editorial", "system")).toBe("editorial");
    expect(pairing("modern", "humanist")).toBe("fresh");
    expect(pairing("system", "modern")).toBe("retail");
  });

  it("leaves a variant today's registry no longer knows for the strict parse to reject", () => {
    const legacy = fixture(6);
    legacy.blocks.header.variant = "retired-header";
    expect(() => upgradeThemeDocument(legacy)).toThrow();
    expect(parseStoredStorefrontThemeDocument(JSON.stringify(legacy))).toBeNull();
  });

  it("rejects malformed and future documents", () => {
    for (const invalid of [null, [], {}, { version: 0 }, { version: STOREFRONT_THEME_DOCUMENT_VERSION + 1 }, { ...DEFAULT_STOREFRONT_THEME, extra: true }]) {
      expect(() => upgradeThemeDocument(invalid)).toThrow();
    }
    expect(parseStoredStorefrontThemeDocument(JSON.stringify({ version: 3, tokens: {} }))).toBeNull();
  });
});

// v8's ten templates and thirteen card variants, frozen here as the v8 to v9 step reads them.
const V8_TEMPLATE_PRESETS: Record<string, string> = {
  "department-mall": "department-mall", "spec-catalogue": "department-mall", "rounded-tech": "department-mall",
  boutique: "boutique", "heritage-editorial": "boutique", "fashion-value": "boutique",
  marketplace: "marketplace", "mass-retail": "marketplace",
  "daily-essentials": "daily-essentials", "showcase-landing": "showcase-landing",
};

type V8Case = {
  variant: string;
  settings?: Record<string, boolean>;
  facts: string;
  action: string;
  /** The look the card carried in v8, which becomes the theme's photo tokens; null follows the stored tokens. */
  look: { imageRatio: string; imageFit: string; surface: string } | null;
};
const look = (imageRatio: string, imageFit: string, surface: string) => ({ imageRatio, imageFit, surface });
const V8_CARDS: V8Case[] = [
  { variant: "standard", facts: "none", action: "none", look: null },
  { variant: "boutique", facts: "none", action: "none", look: look("square", "cover", "flat") },
  { variant: "boutique", settings: { quickAction: true }, facts: "none", action: "quick-add", look: look("square", "cover", "flat") },
  { variant: "showcase", facts: "none", action: "full", look: look("square", "cover", "flat") },
  { variant: "portrait", facts: "none", action: "none", look: look("portrait", "cover", "flat") },
  { variant: "fashion-value", facts: "none", action: "quick-add", look: look("square", "cover", "hairline") },
  { variant: "spec", facts: "key-specs", action: "full", look: look("square", "contain", "hairline") },
  { variant: "tech-rounded", facts: "none", action: "full", look: look("landscape", "contain", "raised") },
  { variant: "retail", facts: "swatches", action: "full", look: look("square", "contain", "flat") },
  { variant: "retail", settings: { quickAction: true }, facts: "delivery", action: "full", look: look("square", "contain", "flat") },
  { variant: "marketplace", facts: "none", action: "none", look: look("square", "contain", "flat") },
  { variant: "quick-add", facts: "delivery", action: "quick-add", look: look("square", "contain", "hairline") },
  { variant: "quick-add", settings: { fullAction: true }, facts: "none", action: "full", look: look("square", "contain", "hairline") },
  { variant: "mall", facts: "none", action: "none", look: look("square", "contain", "hairline") },
  { variant: "detailed", facts: "swatches", action: "full", look: look("square", "contain", "flat") },
];

describe("v8 to v9: one design system", () => {
  const v8Document = (template: string, card: { variant: string; settings: Record<string, unknown> }) => {
    const doc = fixture(8);
    doc.template = template;
    doc.blocks.card = card;
    return doc;
  };
  const photoTokens = (tokens: Record<string, unknown>) => ({ imageRatio: tokens.imageRatio, imageFit: tokens.imageFit, surface: tokens.surface });

  it.each(Object.entries(V8_TEMPLATE_PRESETS))("reads the v8 %s template as the %s preset", (template, preset) => {
    const stored = v8Document(template, { variant: "standard", settings: { hoverImage: false } });
    const upgraded = upgradeThemeDocument(stored);
    expect(upgraded.template).toBe(preset);
    expect(storefrontThemeDocumentSchema.safeParse(upgraded).success).toBe(true);
    // Every v8 template id maps to a preset that exists today.
    expect(STOREFRONT_TEMPLATE_IDS).toContain(preset);
  });

  it("maps every v8 template id and nothing else", () => {
    expect(Object.keys(V8_TEMPLATE_PRESETS)).toHaveLength(10);
    expect(() => upgradeThemeDocument(v8Document("classic", { variant: "standard", settings: { hoverImage: false } }))).toThrow();
  });

  it.each(V8_CARDS.map((each) => [`${each.variant}${each.settings ? ` ${JSON.stringify(each.settings)}` : ""}`, each] as const))(
    "reads the v8 %s card as one card with its facts, action and photo tokens",
    (_name, each) => {
      for (const hoverImage of [false, true]) {
        const stored = v8Document("heritage-editorial", { variant: each.variant, settings: { hoverImage, ...each.settings } });
        // Start from photo tokens no look uses, so a look that did not move them shows.
        stored.tokens.imageRatio = "landscape";
        stored.tokens.imageFit = "contain";
        stored.tokens.surface = "raised";
        const before = structuredClone(stored);
        const upgraded = upgradeThemeDocument(stored);
        expect(stored).toEqual(before);
        expect(storefrontThemeDocumentSchema.safeParse(upgraded).success).toBe(true);
        expect(upgraded.blocks.card).toEqual({ variant: "standard", settings: { facts: each.facts, action: each.action, hoverImage } });
        expect(photoTokens(upgraded.tokens)).toEqual(each.look ?? photoTokens(stored.tokens));
      }
    },
  );

  it("covers every v8 card variant", () => {
    expect(new Set(V8_CARDS.map((each) => each.variant))).toEqual(new Set([
      "standard", "boutique", "showcase", "portrait", "fashion-value", "spec", "tech-rounded", "retail", "marketplace", "quick-add", "mall", "detailed",
    ]));
  });

  it("keeps a stored hover image and treats an unstored one as off", () => {
    const stored = v8Document("boutique", { variant: "boutique", settings: { quickAction: false } });
    expect(upgradeThemeDocument(stored).blocks.card.settings).toMatchObject({ hoverImage: false });
    stored.blocks.card.settings.hoverImage = true;
    expect(upgradeThemeDocument(stored).blocks.card.settings).toMatchObject({ hoverImage: true });
  });

  it("changes only the template, the card and its photo tokens", () => {
    const stored = v8Document("fashion-value", { variant: "tech-rounded", settings: { hoverImage: false } });
    const upgraded = upgradeThemeDocument(stored);
    const withoutCard = ({ card: _card, ...blocks }: Record<string, unknown>) => blocks;
    const withoutPhoto = ({ imageRatio: _ratio, imageFit: _fit, surface: _surface, ...tokens }: Record<string, unknown>) => tokens;
    expect(withoutCard(upgraded.blocks)).toEqual(withoutCard(stored.blocks));
    expect(withoutPhoto(upgraded.tokens)).toEqual(withoutPhoto(stored.tokens));
    expect(upgraded.tokens.colors.primary).toBe("#123456");
    expect(upgraded.pages).toEqual(stored.pages);
    expect(upgraded.brand).toEqual(stored.brand);
    expect(upgraded.version).toBe(9);
  });

  it("leaves a v8 card variant it never had for the strict parse to reject", () => {
    expect(() => upgradeThemeDocument(v8Document("boutique", { variant: "hamburger", settings: {} }))).toThrow();
  });
});

describe("landing pages", () => {
  it("accepts bounded landing pages under non-reserved handles", () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    const page = { title: "ঈদ অফার", description: "", sections: [storefrontSectionDefault("editorial", "story")] };
    theme.pages.landing["eid-offer"] = page;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
    for (const slug of ["products", "pages", "bad/slug", "../escape", "New-Page"]) {
      expect(storefrontThemeDocumentSchema.safeParse({ ...theme, pages: { ...theme.pages, landing: { [slug]: page } } }).success, slug).toBe(false);
    }
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, pages: { ...theme.pages, landing: { eid: { ...page, title: " " } } } }).success).toBe(false);
    theme.pages.landing = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`page-${index}`, page]));
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
  });

  it("keeps hidden sections in storage but removes their rendering and bounded reads", () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    const delivery = { ...storefrontSectionDefault("usp-strip", "delivery"), hidden: true };
    const rail = { ...storefrontSectionDefault("product-rail", "products"), hidden: true };
    theme.pages.home = [delivery, rail];
    theme.pages.landing.offer = { title: "Offer", description: "", sections: [delivery, rail] };
    expect(homeSectionRequests(theme.pages.home).lists).toEqual([]);
    expect(homeSectionsShowDeliveryFacts(theme.pages.home)).toBe(false);
    const resolved = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE);
    expect(resolved.pages.home).toEqual([]);
    expect(resolved.pages.landing.offer!.sections).toEqual([]);
    expect(theme.pages.home).toHaveLength(2);
  });
});

describe("tightened bounds inside a version", () => {
  it("reads a stored v8 document whose filter rows were 16 px apart, raised to the 24 px target size", () => {
    const stored = structuredClone(v8) as Record<string, any>;
    stored.blocks ??= {};
    stored.blocks.listing ??= {};
    stored.blocks.listing.filters = { ...(stored.blocks.listing.filters ?? {}), rowPitch: 16 };
    const parsed = parseStoredStorefrontThemeDocument(JSON.stringify(stored));
    expect(parsed).not.toBeNull();
    expect(parsed?.blocks.listing.filters?.rowPitch).toBe(24);
  });

  it("reads the retired app-panel and story-cards heroes as the contained and full-bleed banners, slides kept", () => {
    const slide = { image: "m1", focalPoint: { x: 50, y: 50 }, alt: "Eid", heading: "Eid sale", text: "Up to half off", link: null };
    const stored = structuredClone(v9) as Record<string, any>;
    stored.pages.home = [
      { id: "hero", type: "hero", version: 1, settings: { layout: "app-panel", slides: [slide] } },
      { id: "stories", type: "hero", version: 1, settings: { layout: "story-cards", slides: [slide] } },
    ];
    stored.pages.landing = { offer: { sections: [{ id: "hero", type: "hero", version: 1, settings: { layout: "story-cards", slides: [slide] } }] } };
    const parsed = parseStoredStorefrontThemeDocument(JSON.stringify(stored));
    expect(parsed).not.toBeNull();
    expect(parsed?.pages.home.map((each) => (each.settings as { layout?: string }).layout)).toEqual(["contained-banners", "full-bleed"]);
    expect((parsed?.pages.landing.offer!.sections[0]!.settings as { layout?: string; slides: unknown[] })).toMatchObject({ layout: "full-bleed", slides: [slide] });
    // Saving a retired layout is rejected: it is no longer a choice.
    expect(storefrontThemeDocumentSchema.safeParse(stored).success).toBe(false);
  });
});

describe("a stored sale colour the v9 card cannot read on", () => {
  // Saved before v9's card checked the sale colour on the card colour: AA on
  // the page (4.83:1 on white), 4.09:1 on the grey card.
  const failing = (doc: Record<string, any>) => {
    doc.tokens.colors = { ...doc.tokens.colors, background: "#ffffff", card: "#ececec", destructive: "#dc2626", "destructive-foreground": "#ffffff" };
    return doc;
  };
  const readable = (doc: StorefrontThemeDocument) => {
    const { colors } = doc.tokens;
    expect(storefrontThemeContrast(colors.destructive, colors.card)).toBeGreaterThanOrEqual(4.5);
    expect(storefrontThemeContrast(colors.destructive, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(storefrontThemeContrast(colors["destructive-foreground"], colors.destructive)).toBeGreaterThanOrEqual(4.5);
    expect(listStorefrontThemeDocumentContrastProblems(doc)).toEqual([]);
  };

  it("fails the save schema, so the editor cannot save it", () => {
    const doc = failing(structuredClone(v9) as Record<string, any>);
    const result = storefrontThemeDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toContainEqual([
      "tokens.colors.destructive",
      expect.stringMatching(/^destructive on card has contrast 4\.0\d:1; it needs at least 4\.5:1\.$/),
    ]);
  });

  for (const version of [8, 9] as const) {
    it(`still reads a stored v${version} document, with the sale colour darkened until it reaches AA on the card`, () => {
      const stored = failing(fixture(version));
      if (version === 8) stored.blocks.card = { variant: "standard", settings: { hoverImage: false } };
      const before = structuredClone(stored);
      const parsed = parseStoredStorefrontThemeDocument(JSON.stringify(stored));
      expect(parsed).not.toBeNull();
      expect(stored).toEqual(before);
      readable(parsed!);
      // Darker (the card is light), still red, and only as far as it needs to go.
      expect(parsed!.tokens.colors.destructive).not.toBe("#dc2626");
      expect(storefrontThemeContrast(parsed!.tokens.colors.destructive, "#ececec")).toBeLessThan(5.2);
      // Nothing else moves.
      const { destructive: _d, "destructive-foreground": _f, ...rest } = parsed!.tokens.colors;
      const { destructive: _sd, "destructive-foreground": _sf, ...storedRest } = stored.tokens.colors;
      expect(rest).toEqual(storedRest);
    });
  }

  it("lightens the sale colour on a dark card", () => {
    const stored = fixture(9);
    stored.tokens.colors = { ...STOREFRONT_THEME_PALETTES.midnight, card: "#2a2a30", destructive: "#e05252" };
    const parsed = parseStoredStorefrontThemeDocument(JSON.stringify(stored));
    expect(parsed).not.toBeNull();
    readable(parsed!);
  });

  it("leaves a readable sale colour as stored", () => {
    expect(upgradeThemeDocument(fixture(9)).tokens.colors).toEqual(fixture(9).tokens.colors);
  });
});
