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
    const source = withContent();
    source.pages.landing.offer = { title: "ঈদ অফার", description: "", sections: [source.pages.home[0]!] };
    const next = storefrontThemeWithContent(storefrontTemplateTheme("daily-essentials"), source);
    expect(storefrontThemeDocumentSchema.safeParse(next).success).toBe(true);
    expect(next.template).toBe("daily-essentials");
    expect(next.brand.logo).toBe("media_logo");
    expect(next.pages.homeMode).toEqual({ kind: "product", productId: "prod_1" });
    expect(next.pages.landing).toEqual(source.pages.landing);
    expect(next.blocks.footer.settings).toMatchObject({ tagline: "Since 1998", copyright: "Acme Ltd." });
    // The announcement's words move into the preset's own bar.
    expect(next.blocks.topBar).toEqual({ variant: "utility", settings: { text: "Cash on delivery everywhere", link: "/delivery" } });
    // A target without a top bar keeps none.
    const noBar = storefrontTemplateTheme("daily-essentials");
    noBar.blocks.topBar = { variant: "none", settings: {} };
    expect(storefrontThemeWithContent(noBar, source).blocks.topBar).toEqual({ variant: "none", settings: {} });
    const hero = next.pages.home.find((section) => section.type === "hero");
    expect(hero?.type === "hero" && hero.settings.slides).toEqual([slide]);
    expect(hero?.type === "hero" && hero.settings.layout).toBe("full-bleed");
    const tiles = next.pages.home.find((section) => section.type === "category-tiles");
    expect(tiles?.type === "category-tiles" && tiles.settings).toEqual({ style: "photo", title: "Departments", categoryIds: ["cat_a", "cat_b"] });
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

  it("validates hidden landing images while public section reads omit them", async () => {
    const { storefrontThemeMediaReferences } = await import("./content");
    const theme = withContent();
    const hero = { ...theme.pages.home[0]!, hidden: true };
    theme.pages.landing.offer = { title: "Offer", description: "", sections: [hero] };
    expect(storefrontThemeMediaReferences(theme)).toContainEqual({ path: "pages.landing.offer.sections.0.settings.slides.0.image", mediaId: "media_hero" });
  });

  it("leaves out images deleted from Files, keeping the document valid and every other image", async () => {
    const { storefrontThemeMediaIds, storefrontThemeWithoutMedia } = await import("./content");
    const { storefrontSectionDefault } = await import("./sections");
    const theme = withContent();
    const heroIndex = theme.pages.home.findIndex((section) => section.type === "hero");
    const hero = theme.pages.home[heroIndex]! as Extract<StorefrontThemeDocument["pages"]["home"][number], { type: "hero" }>;
    hero.settings.slides.push({ ...hero.settings.slides[0]!, image: "media_kept", phoneImage: "media_gone_phone" });
    hero.settings.sideBanners = [
      { mediaId: "media_gone_side", alt: "", href: null },
      { mediaId: "media_side", alt: "", href: null },
    ];
    const banner = { ...storefrontSectionDefault("banner", "banner"), settings: { ...storefrontSectionDefault("banner", "banner").settings, mediaId: "media_gone_banner" } };
    const mosaic = { ...storefrontSectionDefault("banner-mosaic", "mosaic"), settings: { tiles: [
      { mediaId: "media_gone_tile", alt: "", href: null },
      { mediaId: "media_tile", alt: "", href: null },
    ] } };
    theme.pages.home.push(mosaic as never, banner as never);
    theme.pages.landing.offer = { title: "Offer", description: "", sections: [structuredClone(hero)] };
    const missing = new Set(["media_logo", "media_hero", "media_gone_phone", "media_gone_side", "media_gone_banner", "media_gone_tile"]);
    const restored = storefrontThemeWithoutMedia(theme, missing);

    expect(storefrontThemeMediaIds(restored).filter((id) => missing.has(id))).toEqual([]);
    expect(restored.brand).toMatchObject({ logo: null, footerLogo: "media_footer_logo", favicon: "media_icon" });
    const restoredHero = restored.pages.home[heroIndex]! as typeof hero;
    // The slide whose photo is gone is left out; the other keeps its photo without the missing phone image.
    expect(restoredHero.settings.slides).toHaveLength(1);
    expect(restoredHero.settings.slides[0]).toMatchObject({ image: "media_kept" });
    expect(restoredHero.settings.slides[0]).not.toHaveProperty("phoneImage");
    expect(restoredHero.settings.sideBanners).toEqual([{ mediaId: "media_side", alt: "", href: null }]);
    expect(restored.pages.home.at(-1)!.settings).toMatchObject({ mediaId: null });
    expect(restored.pages.home.at(-2)!.settings).toEqual({ tiles: [{ mediaId: "media_tile", alt: "", href: null }] });
    expect(restored.pages.landing.offer!.sections[0]!.settings).toMatchObject({ slides: [{ image: "media_kept" }] });
    expect(storefrontThemeDocumentSchema.safeParse(restored).error?.issues ?? []).toEqual([]);
    // Nothing missing: the same document.
    expect(storefrontThemeWithoutMedia(theme, new Set())).toBe(theme);
  });
});
