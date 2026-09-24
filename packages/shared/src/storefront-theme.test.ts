import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_CARD_STYLES,
  STOREFRONT_DENSITIES,
  STOREFRONT_PRODUCT_PAGE_LAYOUTS,
  STOREFRONT_STYLE_PRESETS,
  STOREFRONT_THEME_PALETTES,
  STOREFRONT_THEME_TEXT_PAIRS,
  buildStorefrontThemeTokens,
  listStorefrontThemeContrastProblems,
  listStorefrontThemeSemanticColorProblems,
  parseStoredStorefrontThemeDocument,
  resolveStorefrontThemeLayout,
  storefrontStylePresetTheme,
  storefrontThemeContrast,
  storefrontThemeDocumentJsonSchema,
  storefrontThemeDocumentSchema,
  type StorefrontThemeDocument,
} from "./storefront-theme";

const issues = (value: unknown) => {
  const result = storefrontThemeDocumentSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

const clone = (): StorefrontThemeDocument => structuredClone(DEFAULT_STOREFRONT_THEME);

describe("storefront theme document v2", () => {
  it("accepts every Style preset as a complete configured document", () => {
    for (const { key } of STOREFRONT_STYLE_PRESETS) {
      const theme = storefrontStylePresetTheme(key);
      expect(issues(theme), key).toEqual([]);
      expect(theme.mode).toBe("configured");
      expect(theme.version).toBe(2);
    }
  });

  it("passes WCAG AA on every text pair in every palette", () => {
    for (const [name, colors] of Object.entries(STOREFRONT_THEME_PALETTES)) {
      expect(listStorefrontThemeContrastProblems(colors), name).toEqual([]);
    }
    expect(STOREFRONT_THEME_TEXT_PAIRS.length).toBeGreaterThan(10);
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
    // A crimson hint next to a crimson error (R3-SB-05) is rejected on write.
    const theme = clone();
    theme.tokens.colors["muted-foreground"] = "#9f1239";
    theme.tokens.colors.destructive = "#991b1b";
    expect(issues(theme).join("\n")).toMatch(/near-neutral/);
    expect(issues(theme).join("\n")).toMatch(/looks too much like error text/);
  });

  it("rejects old versions, unknown keys and values outside the curated set", () => {
    expect(issues({ ...clone(), version: 1 })).not.toEqual([]);
    expect(issues({ ...clone(), extra: true })).not.toEqual([]);
    expect(issues({ ...clone(), layout: { ...clone().layout, density: "tiny" } })).not.toEqual([]);
    expect(issues({ ...clone(), layout: { ...clone().layout, sidebar: "left" } })).not.toEqual([]);
    const missingColor = clone();
    delete (missingColor.tokens.colors as Record<string, string>).ring;
    expect(issues(missingColor)).not.toEqual([]);
    const namedColor = clone();
    namedColor.tokens.colors.border = "red";
    expect(issues(namedColor)).not.toEqual([]);
  });

  it("requires each theme section exactly once in a configured document", () => {
    const missing = clone();
    missing.sections = missing.sections.filter((section) => section.type !== "delivery");
    expect(issues(missing).join()).toMatch(/delivery section exactly once/);

    const duplicate = clone();
    duplicate.sections.push({ id: "hero-2", type: "hero", version: 1, settings: {} });
    expect(issues(duplicate).join()).toMatch(/hero section exactly once/);

    const sameId = clone();
    sameId.sections[1] = { ...sameId.sections[1]!, id: sameId.sections[0]!.id };
    expect(issues(sameId).join()).toMatch(/unique/);
  });

  it("lets a custom document omit theme sections and add builder sections", () => {
    const custom: StorefrontThemeDocument = {
      ...clone(),
      mode: "custom",
      sections: [
        { id: "story", type: "rich_text", version: 1, settings: { heading: "Our story", body: "Hand-made in Rajshahi." } },
        { id: "hero", type: "hero", version: 1, settings: {} },
      ],
    };
    expect(issues(custom)).toEqual([]);
    expect(issues({ ...custom, sections: [...custom.sections, { id: "h2", type: "hero", version: 1, settings: {} }] }).join())
      .toMatch(/at most once/);
    // Section schemas are versioned: an unknown type or version is rejected.
    expect(issues({ ...custom, sections: [{ id: "x", type: "video", version: 1, settings: {} }] })).not.toEqual([]);
    expect(issues({ ...custom, sections: [{ id: "x", type: "rich_text", version: 2, settings: { heading: "", body: "" } }] })).not.toEqual([]);
  });

  it("reads stored documents strictly", () => {
    expect(parseStoredStorefrontThemeDocument(JSON.stringify(DEFAULT_STOREFRONT_THEME))).toEqual(DEFAULT_STOREFRONT_THEME);
    expect(parseStoredStorefrontThemeDocument(null)).toBeNull();
    expect(parseStoredStorefrontThemeDocument("{not json")).toBeNull();
    // A version 1 document (before this contract) is not read.
    expect(parseStoredStorefrontThemeDocument(JSON.stringify({
      colors: {}, typography: { heading: "system", body: "system", scale: "standard" },
      cornerStyle: "subtle", density: "comfortable", containerWidth: "wide",
      components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
    }))).toBeNull();
  });

  it("resolves every layout choice to concrete rendering facts", () => {
    for (const card of STOREFRONT_CARD_STYLES) {
      for (const density of STOREFRONT_DENSITIES) {
        for (const productPage of STOREFRONT_PRODUCT_PAGE_LAYOUTS) {
          const resolved = resolveStorefrontThemeLayout({ ...clone().layout, card, density, productPage });
          const rem = (value: string) => Number.parseFloat(value);
          // Card minimums grow with the container, and two cards fit a 360px phone (328px of content).
          expect(rem(resolved.grid.cardMin.phone)).toBeLessThanOrEqual(rem(resolved.grid.cardMin.tablet));
          expect(rem(resolved.grid.cardMin.tablet)).toBeLessThanOrEqual(rem(resolved.grid.cardMin.desktop));
          expect(2 * rem(resolved.grid.cardMin.phone) * 16 + rem(resolved.grid.gap.phone) * 16).toBeLessThanOrEqual(328);
          expect(["square", "portrait"]).toContain(resolved.productCard.imageRatio);
          // A stacked gallery never keeps thumbnails beside it.
          const { gallery, thumbnails } = resolved.productPage as { gallery: string; thumbnails: string };
          expect(gallery === "stacked" && thumbnails === "beside").toBe(false);
        }
      }
    }
  });

  it("builds CSS tokens from constants and validated colours only", () => {
    const tokens = buildStorefrontThemeTokens(clone());
    expect(tokens.background).toBe("#ffffff");
    expect(tokens.radius).toBe("0.4rem");
    expect(tokens["theme-card-min-phone"]).toBe("9.25rem");
    for (const value of Object.values(tokens)) expect(value).not.toMatch(/[;{}<>\\]/);
  });

  it("publishes a JSON Schema for the document", () => {
    const schema = storefrontThemeDocumentJsonSchema();
    expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining(["version", "mode", "tokens", "layout", "sections"]) });
    expect(JSON.stringify(schema)).toContain("rich_text");
  });
});
