import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_FONTS,
  STOREFRONT_HEADER_TONES,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  STOREFRONT_TEMPLATES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_PALETTES,
  STOREFRONT_THEME_TEXT_PAIRS,
  STOREFRONT_TYPE_PAIRING_SPECS,
  STOREFRONT_BLOCK_REGISTRY,
  buildStorefrontThemeTokens,
  listStorefrontThemeContrastProblems,
  listStorefrontThemeSemanticColorProblems,
  parseStoredStorefrontThemeDocument,
  resolveStorefrontTheme,
  storefrontBlockVariants,
  storefrontPairingFonts,
  storefrontSectionDefault,
  storefrontSectionRenderer,
  storefrontTemplateTheme,
  storefrontThemeContrast,
  storefrontThemeContrastPairs,
  storefrontThemeDocumentJsonSchema,
  storefrontThemeDocumentSchema,
  storefrontVariantChain,
  storefrontVariantSpec,
  type StorefrontThemeDocument,
} from "./storefront-theme";

const issues = (value: unknown) => {
  const result = storefrontThemeDocumentSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

const clone = (): StorefrontThemeDocument => structuredClone(DEFAULT_STOREFRONT_THEME);

/**
 * What the version 3 default (the Classic preset) rendered, captured from
 * the v3 code at 878e43cf6. The default (v4 and v5) must render exactly this until
 * the new block renderers land, so today's store and the owner-protected
 * product page stay pixel-identical.
 */
const V3_CLASSIC = {
  layout: {
    header: "classic",
    footer: "columns",
    productCard: { imageRatio: "square", hoverImage: false, quickBuy: false, badge: "image" },
    density: "compact",
    grid: { cardMin: { phone: "9.25rem", tablet: "11rem", desktop: "12.5rem" }, gap: { phone: "0.5rem", desktop: "1rem" } },
    productPage: { gallery: "beside", thumbnails: "beside" },
    navigation: "menu",
    mobileNavigation: "drawer",
    cardSurface: "bordered",
  },
  css: {
    popover: "#ffffff", "popover-foreground": "#1d1c1a", ring: "#1d1c1a", background: "#ffffff", foreground: "#1d1c1a",
    card: "#ffffff", "card-foreground": "#1d1c1a", primary: "#1d1c1a", "primary-foreground": "#fbfaf7",
    secondary: "#f1eee8", "secondary-foreground": "#1d1c1a", muted: "#f1eee8", "muted-foreground": "#5d5850",
    accent: "#e9e3d8", "accent-foreground": "#1d1c1a", destructive: "#b42318", "destructive-foreground": "#ffffff",
    border: "#e5e0d6", input: "#d3ccbf",
    "theme-font-heading": '"Inter", "Noto Sans Bengali", "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, "Noto Sans Bengali UI", Vrinda, sans-serif',
    "theme-font-body": '"Inter", "Noto Sans Bengali", "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, "Noto Sans Bengali UI", Vrinda, sans-serif',
    "theme-heading-weight": "650", "theme-heading-tracking": "-0.02em", "theme-heading-leading": "1.15",
    "theme-body-leading": "1.6", "theme-label-tracking": "0.06em", "theme-type-scale": "0.92",
    radius: "0.4rem", "theme-button-radius": "0.4rem", "theme-density-scale": "0.92",
    "theme-card-min-phone": "9.25rem", "theme-card-min-tablet": "11rem", "theme-card-min-desktop": "12.5rem",
    "theme-grid-gap-phone": "0.5rem", "theme-grid-gap-desktop": "1rem", "theme-container-width": "90rem",
  },
  sections: ["hero", "collections", "category-tiles", "usp-strip"],
} as const;

describe("storefront theme document v5", () => {
  it("parses every template as a complete document in its own palette", () => {
    expect(STOREFRONT_TEMPLATES.map((template) => template.id)).toEqual([...STOREFRONT_TEMPLATE_IDS]);
    expect(STOREFRONT_TEMPLATE_IDS).toHaveLength(10);
    for (const template of STOREFRONT_TEMPLATES) {
      const theme = storefrontTemplateTheme(template.id);
      expect(issues(theme), template.id).toEqual([]);
      expect(theme).toMatchObject({ version: 5, template: template.id });
      expect(theme.tokens.colors).toEqual(STOREFRONT_THEME_PALETTES[template.palette]);
      expect(Object.isFrozen(template.blocks.product.below)).toBe(true);
    }
  });

  it("keeps the templates apart: no two share every block", () => {
    const shapes = new Set(STOREFRONT_TEMPLATES.map((template) => JSON.stringify(template.blocks)));
    expect(shapes.size).toBe(STOREFRONT_TEMPLATES.length);
    // The measured density and header grammar survive into the data.
    expect(storefrontTemplateTheme("spec-catalogue").tokens).toMatchObject({ density: "dense", typeScale: "flat", headerTone: "dark", container: "1290" });
    expect(storefrontTemplateTheme("boutique").tokens).toMatchObject({ density: "airy", typeScale: "display", container: "1200" });
    expect(storefrontTemplateTheme("heritage-editorial").tokens).toMatchObject({ headingCase: "uppercase", imageRatio: "portrait" });
    expect(storefrontTemplateTheme("rounded-tech").tokens).toMatchObject({ radius: "soft", buttonShape: "pill", surface: "raised" });
  });

  it("renders the version 3 classic look from the default document", () => {
    expect(DEFAULT_STOREFRONT_THEME.template).toBe("department-mall");
    const resolved = resolveStorefrontTheme(DEFAULT_STOREFRONT_THEME, {
      ...EMPTY_STORE_SHAPE,
      productCount: 20,
      skuCount: 30,
      topCategoryCount: 5,
      categoryDepth: 1,
      menuTopItems: 6,
      menuDepth: 2,
    });
    expect(resolved.layout).toMatchObject(V3_CLASSIC.layout);
    const css = buildStorefrontThemeTokens(DEFAULT_STOREFRONT_THEME);
    for (const [key, value] of Object.entries(V3_CLASSIC.css)) expect(css[key], key).toBe(value);
    // Today's homepage blocks in today's order.
    expect(resolved.pages.home.map(storefrontSectionRenderer)).toEqual(V3_CLASSIC.sections);
    // The owner-protected product page.
    expect(resolved.blocks.product).toMatchObject({
      gallery: { variant: "classic" },
      buyBox: { variant: "classic" },
      below: ["description", "reviews", "related"],
      sticky: { phoneTop: "none", phoneBottom: "buy-bar", desktop: "none" },
    });
    // On a store too small for the departments rail it still renders the classic menu.
    expect(resolveStorefrontTheme(DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE).layout).toMatchObject(V3_CLASSIC.layout);
  });

  it("passes WCAG AA on every pair every block can paint, in every palette and header tone", () => {
    const allPairs = new Map<string, readonly [string, string]>();
    for (const slot of STOREFRONT_BLOCK_SLOTS) {
      for (const id of storefrontBlockVariants(slot)) {
        for (const pair of storefrontVariantSpec(slot, id).contrastPairs) allPairs.set(pair.join("/"), pair);
      }
    }
    for (const pair of STOREFRONT_THEME_TEXT_PAIRS) allPairs.set(pair.join("/"), pair);
    for (const [name, colors] of Object.entries(STOREFRONT_THEME_PALETTES)) {
      for (const tone of STOREFRONT_HEADER_TONES) {
        expect(listStorefrontThemeContrastProblems(colors, [...allPairs.values()] as never, tone), `${name}/${tone}`).toEqual([]);
      }
    }
  });

  it("checks the pairs of the chosen variants and of every variant they fall back to", () => {
    const theme = clone();
    const base = storefrontThemeContrastPairs(theme.blocks).map((pair) => pair.join("/"));
    expect(base).not.toContain("destructive/card");
    theme.blocks.card = { variant: "retail", settings: {} };
    expect(storefrontThemeContrastPairs(theme.blocks).map((pair) => pair.join("/"))).toContain("destructive/card");
    // A light red that passes on a dark page but not on lighter dark cards
    // is caught only when a card paints it.
    theme.tokens.colors = { ...STOREFRONT_THEME_PALETTES.midnight, card: "#3a3a40", popover: "#3a3a40" };
    expect(issues(theme).join("\n")).toMatch(/^tokens\.colors\.destructive: destructive on card has contrast/);
    expect(issues({ ...theme, blocks: clone().blocks })).toEqual([]);
    expect(storefrontVariantChain("header", "boutique-inline")).toEqual(["boutique-inline", "fashion-department"]);
  });

  it("computes WCAG contrast", () => {
    expect(storefrontThemeContrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(storefrontThemeContrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("rejects low-contrast colours on write", () => {
    const theme = clone();
    theme.tokens.colors["primary-foreground"] = "#1a8a45";
    expect(issues(theme).join("\n")).toMatch(/primary-foreground on primary has contrast/);
  });

  it("keeps helper text neutral and apart from error text in every palette", () => {
    for (const [name, colors] of Object.entries(STOREFRONT_THEME_PALETTES)) {
      expect(listStorefrontThemeSemanticColorProblems(colors), name).toEqual([]);
    }
    const theme = clone();
    theme.tokens.colors["muted-foreground"] = "#9f1239";
    theme.tokens.colors.destructive = "#991b1b";
    expect(issues(theme).join("\n")).toMatch(/near-neutral/);
    expect(issues(theme).join("\n")).toMatch(/looks too much like error text/);
  });

  it("rejects old versions, unknown keys and values outside the curated sets", () => {
    expect(issues({ ...clone(), version: 4 })).not.toEqual([]);
    expect(issues({ ...clone(), template: "classic" })).not.toEqual([]);
    expect(issues({ ...clone(), mode: "configured" })).not.toEqual([]);
    expect(issues({ ...clone(), extra: true })).not.toEqual([]);
    expect(issues({ ...clone(), tokens: { ...clone().tokens, density: "tiny" } })).not.toEqual([]);
    expect(issues({ ...clone(), tokens: { ...clone().tokens, containerWidth: "wide" } })).not.toEqual([]);
    const missingColor = clone();
    delete (missingColor.tokens.colors as Record<string, string>).ring;
    expect(issues(missingColor)).not.toEqual([]);
    const namedColor = clone();
    namedColor.tokens.colors.border = "red";
    expect(issues(namedColor)).not.toEqual([]);
    // A variant takes only its own settings.
    const otherSettings = clone();
    otherSettings.blocks.header = { variant: "spec-two-row", settings: { cartTotal: true } } as never;
    expect(issues(otherSettings)).not.toEqual([]);
    const missingSettings = clone();
    missingSettings.blocks.desktopNav = { variant: "departments-rail", settings: {} } as never;
    expect(issues(missingSettings)).not.toEqual([]);
    const unknownVariant = clone();
    unknownVariant.blocks.card = { variant: "hamburger", settings: {} } as never;
    expect(issues(unknownVariant)).not.toEqual([]);
    const repeatedPiece = clone();
    repeatedPiece.blocks.listing.toolbar = ["sort", "sort"];
    expect(issues(repeatedPiece).join()).toMatch(/appears once/);
    const tabs = clone();
    tabs.blocks.mobileNav = { variant: "bottom-tabs", settings: { tabs: ["home", "home", "cart", "account"], drawer: "accordion" } };
    expect(issues(tabs).join()).toMatch(/appears once/);
    // Version 3 documents are not read at all.
    expect(issues({
      version: 3, mode: "configured", tokens: clone().tokens,
      layout: { header: "classic", footer: "columns", card: "standard", density: "compact", productPage: "gallery", navigation: "menu", mobileNavigation: "drawer" },
      sections: [],
    })).not.toEqual([]);
  });

  it("validates sections from the registry: unique ids, versioned strict settings", () => {
    expect(STOREFRONT_SECTION_TYPES.length).toBeGreaterThanOrEqual(16);
    const theme = clone();
    theme.pages.home.push(storefrontSectionDefault("product-rail", "rail-2"), storefrontSectionDefault("product-rail", "rail-3"));
    expect(issues(theme)).toEqual([]);
    const sameId = clone();
    sameId.pages.home[1] = { ...sameId.pages.home[1]!, id: sameId.pages.home[0]!.id };
    expect(issues(sameId).join()).toMatch(/unique/);
    const tooMany = clone();
    tooMany.pages.home = Array.from({ length: 25 }, (_, index) => storefrontSectionDefault("collections", `c${index}`));
    expect(issues(tooMany)).not.toEqual([]);
    const pages = (home: unknown[]) => ({ ...clone(), pages: { home } });
    expect(issues(pages([{ id: "x", type: "video", version: 1, settings: {} }]))).not.toEqual([]);
    expect(issues(pages([{ id: "x", type: "hero", version: 2, settings: { layout: "split" } }]))).not.toEqual([]);
    expect(issues(pages([{ id: "x", type: "hero", version: 1, settings: { layout: "split", extra: 1 } }]))).not.toEqual([]);
    expect(issues(pages([{ id: "x", type: "banner", version: 1, settings: { layout: "full", heading: "", text: "", mediaId: null, cta: { label: "Go", href: "javascript:alert(1)" } } }]))).not.toEqual([]);
    expect(issues(pages([{ id: "x", type: "banner", version: 1, settings: { layout: "full", heading: "", text: "", mediaId: null, cta: { label: "Go", href: "//evil.test" } } }]))).not.toEqual([]);
    expect(issues(pages([{ id: "x", type: "product-rail", version: 1, settings: { title: "", source: { kind: "collection" }, limit: 12 } }]))).not.toEqual([]);
    // Rich text is plain text with the same limits as before.
    expect(issues(pages([{ id: "story", type: "editorial", version: 1, settings: { layout: "rich-text", heading: "Our story", body: "Hand-made in Rajshahi." } }]))).toEqual([]);
    expect(issues({ ...clone(), pages: { home: [] } })).toEqual([]);
    expect(issues({ ...clone(), pages: { home: [], landing: [] } })).not.toEqual([]);
  });

  it("keeps the registries consistent: defaults parse, fallbacks exist and end in a variant that always fits", () => {
    for (const slot of STOREFRONT_BLOCK_SLOTS) {
      const registry = STOREFRONT_BLOCK_REGISTRY[slot] as Record<string, ReturnType<typeof storefrontVariantSpec>>;
      for (const [id, spec] of Object.entries(registry)) {
        expect(spec.settings.safeParse(spec.defaults).success, `${slot}.${id}`).toBe(true);
        if (spec.requires.length > 0) expect(spec.fallback, `${slot}.${id}`).not.toBeNull();
        const chain = storefrontVariantChain(slot, id);
        const last = storefrontVariantSpec(slot, chain.at(-1)!);
        expect(last.fallback === null || chain.includes(last.fallback), `${slot}.${id} chain`).toBe(true);
        expect(last.requires, `${slot}.${id} ends in ${chain.at(-1)}`).toEqual([]);
      }
    }
    for (const type of STOREFRONT_SECTION_TYPES) {
      const entry = STOREFRONT_SECTION_REGISTRY[type];
      expect(entry.schema.safeParse(storefrontSectionDefault(type, "x")).success, type).toBe(true);
    }
  });

  it("reads stored documents strictly", () => {
    expect(parseStoredStorefrontThemeDocument(JSON.stringify(DEFAULT_STOREFRONT_THEME))).toEqual(DEFAULT_STOREFRONT_THEME);
    expect(parseStoredStorefrontThemeDocument(null)).toBeNull();
    expect(parseStoredStorefrontThemeDocument("{not json")).toBeNull();
    expect(parseStoredStorefrontThemeDocument(JSON.stringify({ ...clone(), version: 4 }))).toBeNull();
  });

  it("builds CSS tokens from constants and validated colours only", () => {
    for (const template of STOREFRONT_TEMPLATES) {
      const tokens = buildStorefrontThemeTokens(storefrontTemplateTheme(template.id));
      for (const value of Object.values(tokens)) expect(value).not.toMatch(/[;{}<>\\]/);
      expect(tokens["theme-container-width"]).toMatch(/^\d+(\.\d+)?rem$/);
      expect(Number(tokens["theme-type-scale"])).toBeGreaterThan(0.85);
    }
    const spec = buildStorefrontThemeTokens(storefrontTemplateTheme("spec-catalogue"));
    // The dark header takes the darker of ink and page.
    expect(spec["theme-header-background"]).toBe(STOREFRONT_THEME_PALETTES.marketplace.foreground);
    const tech = buildStorefrontThemeTokens(storefrontTemplateTheme("rounded-tech"));
    expect(tech["theme-header-background"]).toBe(STOREFRONT_THEME_PALETTES.midnight.background);
    expect(tech["theme-button-radius"]).toBe("9999px");
    expect(tech.radius).toBe("1.25rem");
  });

  it("pairs every template with web fonts that fall back to Bangla and metric-matched faces", () => {
    for (const template of STOREFRONT_TEMPLATES) {
      const theme = storefrontTemplateTheme(template.id);
      const tokens = buildStorefrontThemeTokens(theme);
      const spec = STOREFRONT_TYPE_PAIRING_SPECS[theme.tokens.typography];
      expect(tokens["theme-font-heading"]).toMatch(new RegExp(`^"${STOREFRONT_FONTS[spec.heading].family}", "(Noto Sans Bengali|Noto Serif Bengali|Hind Siliguri)"`));
      expect(tokens["theme-font-heading"]).toContain(`"${STOREFRONT_FONTS[spec.heading].family} Fallback"`);
      expect(Number(tokens["theme-heading-weight"])).toBeGreaterThanOrEqual(400);
    }
    expect(storefrontPairingFonts("editorial")).toEqual({ fonts: ["instrument-serif", "inter"], bangla: "serif", heading: "instrument-serif" });
  });

  it("publishes a JSON Schema for the document", () => {
    const schema = storefrontThemeDocumentJsonSchema();
    expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining(["version", "template", "tokens", "blocks", "pages"]) });
    const text = JSON.stringify(schema);
    expect(text).toContain("usp-strip");
    expect(text).toContain("marketplace-3col");
  });
});
