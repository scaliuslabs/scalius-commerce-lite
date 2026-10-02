import { describe, expect, it } from "vitest";
import { storefrontBlockSwitch } from "./blocks";
import { storefrontThemeBrandMediaIds } from "./brand";
import { storefrontThemeLook, storefrontThemeWithContent } from "./content";
import { storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { EMPTY_STORE_SHAPE } from "./fit";
import { resolveStorefrontTheme } from "./resolve";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme } from "./templates";

const slide = { image: "media_hero", phoneImage: "media_hero_phone", focalPoint: { x: 30, y: 60 }, alt: "Eid sale", link: "/collections/eid" };

/** The default theme with every kind of merchant content filled in. */
function withContent(): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.brand = { logo: "media_logo", logoWidth: 200, footerLogo: "media_footer_logo", favicon: "media_icon" };
  theme.blocks.topBar = { variant: "utility", settings: { text: "Cash on delivery everywhere", link: "/delivery" } };
  theme.blocks.footer = { variant: "product-widgets", settings: { tagline: "Since 1998", about: "Family shop.", copyright: "Acme Ltd." } };
  theme.pages.homeMode = { kind: "product", productId: "prod_1" };
  theme.pages.home = theme.pages.home.map((section) => {
    if (section.type === "hero") return { ...section, settings: { ...section.settings, slides: [slide] } };
    if (section.type === "category-tiles") return { ...section, settings: { ...section.settings, title: "Departments", categoryIds: ["cat_a", "cat_b"] } };
    if (section.type === "collections") return { ...section, settings: { ...section.settings, collectionIds: ["col_a"] } };
    return section;
  });
  return storefrontThemeDocumentSchema.parse(theme);
}

describe("theme content", () => {
  it("validates the brand as media ids and a stepped logo width", () => {
    const theme = withContent();
    expect(storefrontThemeBrandMediaIds(theme.brand)).toEqual(["media_logo", "media_footer_logo", "media_icon"]);
    const brand = (value: object) => storefrontThemeDocumentSchema.safeParse({ ...theme, brand: { ...theme.brand, ...value } }).success;
    expect(brand({ logo: null, footerLogo: null, favicon: null })).toBe(true);
    expect(brand({ logoWidth: 205 })).toBe(false);
    expect(brand({ logoWidth: 60 })).toBe(false);
    expect(brand({ logo: "" })).toBe(false);
    expect(brand({ src: "https://cdn.example/logo.png" })).toBe(false);
  });

  it("keeps the announcement and footer words when a block changes variant, and drops them for no bar", () => {
    const theme = withContent();
    expect(storefrontBlockSwitch("topBar", theme.blocks.topBar, "announcement").settings)
      .toEqual({ text: "Cash on delivery everywhere", link: "/delivery" });
    expect(storefrontBlockSwitch("topBar", theme.blocks.topBar, "none").settings).toEqual({});
    expect(storefrontBlockSwitch("footer", theme.blocks.footer, "directory").settings)
      .toEqual({ style: "columns", tagline: "Since 1998", about: "Family shop.", copyright: "Acme Ltd." });
  });

  it("keeps the footer's words through a fit fallback", () => {
    // product-widgets needs 6 products; the empty store falls back to minimal columns.
    const resolved = resolveStorefrontTheme(withContent(), EMPTY_STORE_SHAPE);
    expect(resolved.blocks.footer.variant).toBe("minimal-columns");
    expect(resolved.blocks.footer.settings).toEqual({ tagline: "Since 1998", about: "Family shop.", copyright: "Acme Ltd." });
    expect(resolved.brand.logo).toBe("media_logo");
    expect(resolved.pages.homeMode).toEqual({ kind: "product", productId: "prod_1" });
  });

  it("carries the merchant's content into another template", () => {
    const next = storefrontThemeWithContent(storefrontTemplateTheme("heritage-editorial"), withContent());
    expect(storefrontThemeDocumentSchema.safeParse(next).success).toBe(true);
    expect(next.template).toBe("heritage-editorial");
    expect(next.brand.logo).toBe("media_logo");
    expect(next.pages.homeMode).toEqual({ kind: "product", productId: "prod_1" });
    expect(next.blocks.footer.settings).toMatchObject({ tagline: "Since 1998", copyright: "Acme Ltd." });
    // Heritage has no top bar: the template's choice stands.
    expect(next.blocks.topBar).toEqual({ variant: "none", settings: {} });
    const hero = next.pages.home.find((section) => section.type === "hero");
    expect(hero?.type === "hero" && hero.settings.slides).toEqual([slide]);
    expect(hero?.type === "hero" && hero.settings.layout).toBe("full-screen");
    const tiles = next.pages.home.find((section) => section.type === "category-tiles");
    expect(tiles?.type === "category-tiles" && tiles.settings).toEqual({ style: "photo-grid", title: "Departments", categoryIds: ["cat_a", "cat_b"] });
  });

  it("compares looks without content: a filled-in template still looks like its template", () => {
    const look = storefrontThemeLook(withContent());
    const template = storefrontThemeLook(storefrontTemplateTheme("department-mall"));
    expect(look.brand).toEqual(template.brand);
    expect(look.pages).toEqual(template.pages);
    expect(look.blocks.topBar.settings).toEqual({ text: "", link: null });
    expect(storefrontThemeWithContent(DEFAULT_STOREFRONT_THEME, null)).toEqual(DEFAULT_STOREFRONT_THEME);
  });
});

describe("theme media references", () => {
  it("lists every image the document names with its path, brand first", async () => {
    const { storefrontThemeMediaIds, storefrontThemeMediaReferences } = await import("./content");
    const theme = withContent();
    const references = storefrontThemeMediaReferences(theme);
    const heroIndex = theme.pages.home.findIndex((section) => section.type === "hero");
    expect(references.slice(0, 5)).toEqual([
      { path: "brand.logo", mediaId: "media_logo" },
      { path: "brand.footerLogo", mediaId: "media_footer_logo" },
      { path: "brand.favicon", mediaId: "media_icon" },
      { path: `pages.home.${heroIndex}.settings.slides.0.image`, mediaId: "media_hero" },
      { path: `pages.home.${heroIndex}.settings.slides.0.phoneImage`, mediaId: "media_hero_phone" },
    ]);
    expect(storefrontThemeMediaIds(theme)).toEqual(["media_logo", "media_footer_logo", "media_icon", "media_hero", "media_hero_phone"]);
  });
});
