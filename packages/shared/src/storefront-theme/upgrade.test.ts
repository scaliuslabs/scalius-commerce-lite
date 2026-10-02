import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE, homeSectionRequests, homeSectionsShowDeliveryFacts,
  parseStoredStorefrontThemeDocument, resolveStorefrontTheme, storefrontSectionDefault,
  storefrontThemeDocumentSchema, upgradeThemeDocument, buildStorefrontTokenCss,
} from "../storefront-theme";

const fixture = (version: number) => JSON.parse(readFileSync(new URL(`./fixtures/v${version}.json`, import.meta.url), "utf8"));

describe("step-wise stored theme upgrades", () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    it(`upgrades the historical v${version} fixture without changing merchant content or input`, () => {
      const stored = fixture(version);
      const before = structuredClone(stored);
      const upgraded = upgradeThemeDocument(stored);
      expect(stored).toEqual(before);
      expect(storefrontThemeDocumentSchema.safeParse(upgraded).success).toBe(true);
      expect(upgraded.version).toBe(7);
      expect(upgradeThemeDocument(upgraded)).toEqual(upgraded);
      expect(parseStoredStorefrontThemeDocument(JSON.stringify(stored))).toEqual(upgraded);
      expect(upgraded.tokens.colors.primary).toBe("#123456");
      expect(upgraded.tokens.typography).toBe(version === 1 ? "retail" : "heritage");
      if (version <= 2) {
        const fonts = version === 1 ? stored.typography : stored.tokens.typography;
        expect(upgraded.tokens.legacyTypography).toEqual({ heading: fonts.heading, body: fonts.body });
      }
      if (version >= 4) {
        expect(upgraded.tokens).toEqual(stored.tokens);
        expect(upgraded.pages.home.map((section) => section.id)).toEqual(stored.pages.home.map((section: { id: string }) => section.id));
        expect(upgraded.pages.home.find((section) => section.id === "merchant-banner")?.settings).toEqual(stored.pages.home.find((section: { id: string }) => section.id === "merchant-banner").settings);
      }
      if (version >= 2) expect(upgraded.pages.home.find((section) => section.id === "merchant-story")).toMatchObject({
        type: "editorial", settings: { layout: "rich-text", heading: "আমাদের গল্প", body: "Made in Rajshahi. নিজের হাতে তৈরি।" },
      });
      if (version === 6) {
        expect(upgraded.brand).toEqual(stored.brand);
        expect(upgraded.pages.home[0]).toEqual(stored.pages.home[0]);
      }
      expect(storefrontThemeDocumentSchema.safeParse(stored).success).toBe(false);
    });
  }

  it("recognizes the actual unversioned pre-v2 semantic shape", () => {
    const legacy = fixture(1);
    delete legacy.version;
    expect(upgradeThemeDocument(legacy)).toEqual(upgradeThemeDocument(fixture(1)));
  });

  it("enriches partial semantic settings with historical defaults and preserves supplied choices", () => {
    const partial = JSON.parse(readFileSync(new URL("./fixtures/v1-partial.json", import.meta.url), "utf8"));
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
    const colors = JSON.parse(readFileSync(new URL("./fixtures/v1-colors.json", import.meta.url), "utf8"));
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

  it("keeps the original independent font stacks instead of substituting a new pairing", () => {
    const theme = upgradeThemeDocument(fixture(2));
    expect(buildStorefrontTokenCss(theme.tokens)).toMatchObject({
      "theme-font-heading": 'Georgia, "Times New Roman", ui-serif, serif',
      "theme-font-body": 'Optima, Candara, "Noto Sans", ui-sans-serif, sans-serif',
    });
  });

  it("rejects malformed and future documents and requires v7 on writes", () => {
    for (const invalid of [null, [], {}, { version: 0 }, { version: 8 }, { ...DEFAULT_STOREFRONT_THEME, extra: true }]) {
      expect(() => upgradeThemeDocument(invalid)).toThrow();
    }
    expect(parseStoredStorefrontThemeDocument(JSON.stringify({ version: 3, tokens: {} }))).toBeNull();
    expect(storefrontThemeDocumentSchema.safeParse(fixture(6)).success).toBe(false);
  });
});

describe("theme page templates", () => {
  it("accepts bounded landing pages and reordered/hidden fixed commerce blocks", () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.landing["eid-offer"] = { title: "ঈদ অফার", sections: [storefrontSectionDefault("editorial", "story")], overrideCms: true };
    theme.pages.product.blocks.reverse();
    theme.pages.product.blocks[0]!.hidden = true;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
    const duplicate = structuredClone(theme);
    duplicate.pages.product.blocks[0] = duplicate.pages.product.blocks[1]!;
    expect(storefrontThemeDocumentSchema.safeParse(duplicate).success).toBe(false);
    for (const slug of ["products", "pages", "bad/slug", "../escape", "New-Page"]) {
      expect(storefrontThemeDocumentSchema.safeParse({ ...theme, pages: { ...theme.pages, landing: { [slug]: theme.pages.landing["eid-offer"] } } }).success, slug).toBe(false);
    }
    theme.pages.landing = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`page-${index}`, theme.pages.landing["eid-offer"]!]));
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
  });

  it("keeps hidden sections in storage but removes their rendering and bounded reads", () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    const delivery = { ...storefrontSectionDefault("usp-strip", "delivery"), hidden: true };
    const rail = { ...storefrontSectionDefault("product-rail", "products"), hidden: true };
    theme.pages.home = [delivery, rail];
    theme.pages.landing["offer"] = { title: "Offer", sections: [delivery, rail], overrideCms: false };
    expect(homeSectionRequests(theme.pages.home).lists).toEqual([]);
    expect(homeSectionsShowDeliveryFacts(theme.pages.home)).toBe(false);
    const resolved = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE);
    expect(resolved.pages.home).toEqual([]);
    expect(resolved.pages.landing.offer!.sections).toEqual([]);
    expect(resolved.pages.product).toEqual(theme.pages.product);
    expect(theme.pages.home).toHaveLength(2);
  });
});
