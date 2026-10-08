// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveThemePreview } = vi.hoisted(() => ({ resolveThemePreview: vi.fn() }));
vi.mock("./api/storefront", () => ({ resolveThemePreview }));

import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_DENSITY_SPECS,
  resolveStorefrontTheme,
  storeShapeFromFacts,
  storefrontTemplateTheme,
} from "@scalius/shared/storefront-theme";
import {
  currentRequestTheme,
  readStoreShape,
  readStorefrontBrandAssets,
  readStorefrontTheme,
  requestThemeFor,
  resolveRequestTheme,
} from "./storefront-theme-context";
import { THEME_PREVIEW_COOKIE_NAME } from "./theme-preview-cookie";

const request = (cookie = "") => new Request("https://shop.test/", { headers: cookie ? { cookie } : {} });
const previewCookie = `${THEME_PREVIEW_COOKIE_NAME}=tpv_${"a".repeat(48)}`;

/** A store with a deep menu, as the layout read serves it. */
const SHAPE = storeShapeFromFacts({
  productCount: 600,
  skuCount: 900,
  topCategoryCount: 9,
  categoryDepth: 1,
  menu: Array.from({ length: 6 }, () => ({ subMenu: [{ subMenu: [{}, {}] }, { subMenu: [{}, {}] }] })),
  hasCollections: true,
  hasDeliveryMethods: true,
});

describe("request theme", () => {
  beforeEach(() => {
    resolveThemePreview.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("resolves once per request and shares the published theme with every reader", async () => {
    const locals = {};
    const published = storefrontTemplateTheme("marketplace");
    const first = await resolveRequestTheme({ request: request(), locals }, { theme: published, storeShape: SHAPE });
    expect(first.theme).toEqual(published);
    expect(first.layout.header).toBe("marketplace");
    expect(first.layout.navigation).toBe("drawer");
    expect(first.resolved.blocks.card.variant).toBe("standard");
    expect(first.layout.productCard).toMatchObject({ facts: "delivery", action: "none", hoverImage: false });
    expect(await resolveRequestTheme({ request: request(), locals }, {})).toBe(first);
    expect(await currentRequestTheme(locals)).toBe(first);
    expect(resolveThemePreview).not.toHaveBeenCalled();
  });

  it("carries the store's language for the storefront's own words", async () => {
    const theme = storefrontTemplateTheme("marketplace");
    const language = async (storefrontCopy?: { languageCode?: unknown }) =>
      (await resolveRequestTheme({ request: request(), locals: {} }, { theme, storeShape: SHAPE, storefrontCopy })).language;
    expect(await language({ languageCode: "bn-BD" })).toBe("bn");
    expect(await language({ languageCode: "bn" })).toBe("bn");
    expect(await language({ languageCode: "en-US" })).toBe("en");
    expect(await language({})).toBe("en");
    expect(await language(undefined)).toBe("en");
    expect(requestThemeFor(theme, SHAPE, { languageCode: "bn" }).language).toBe("bn");
    expect(requestThemeFor(theme, SHAPE).language).toBe("en");
  });

  it("resolves with the same resolver and store shape the dashboard uses", async () => {
    // The layout read serves JSON; the dashboard resolves its in-memory draft.
    const theme = storefrontTemplateTheme("boutique");
    const fromApi = JSON.parse(JSON.stringify({ theme, storeShape: SHAPE })) as { theme: unknown; storeShape: unknown };
    const resolved = await resolveRequestTheme({ request: request(), locals: {} }, fromApi);
    expect(resolved.resolved).toEqual(resolveStorefrontTheme(theme, SHAPE));
    // Boutique keeps its own header at any catalogue size.
    expect(resolved.resolved.blocks.header).toMatchObject({ variant: "boutique-inline" });
    expect(requestThemeFor(theme, SHAPE).resolved).toEqual(resolved.resolved);
  });

  it("renders the dashboard draft while a valid preview cookie is present", async () => {
    resolveThemePreview.mockResolvedValue({ theme: storefrontTemplateTheme("boutique") });
    const resolved = await resolveRequestTheme(
      { request: request(previewCookie), locals: {} },
      { theme: DEFAULT_STOREFRONT_THEME, storeShape: SHAPE },
    );
    expect(resolveThemePreview).toHaveBeenCalledWith(`tpv_${"a".repeat(48)}`);
    expect(resolved.previewToken).toBe(`tpv_${"a".repeat(48)}`);
    expect(resolved.theme.template).toBe("boutique");
    expect(resolved.layout.productPage).toMatchObject({ gallery: "stacked" });
    expect(resolved.layout.productCard).toMatchObject({ facts: "swatches", action: "none", hoverImage: true, imageRatio: "square", imageFit: "cover", surface: "flat" });
    expect(resolved.layout.density).toBe("airy");
    expect(resolved.layout.grid).toBe(STOREFRONT_DENSITY_SPECS.airy);
  });

  it("renders the default theme whole for an invalid preview draft", async () => {
    const draft = storefrontTemplateTheme("boutique");
    resolveThemePreview.mockResolvedValue({ theme: { ...draft, layout: { header: "classic" } } });
    const resolved = await resolveRequestTheme(
      { request: request(previewCookie), locals: {} },
      { theme: storefrontTemplateTheme("marketplace"), storeShape: SHAPE },
    );
    expect(resolved.theme).toBe(DEFAULT_STOREFRONT_THEME);
  });

  it("carries the published theme's brand images, and the draft's under a preview", async () => {
    const published = { ...storefrontTemplateTheme("boutique"), brand: { logo: "med_logo", logoWidth: 160, footerLogo: "med_footer", favicon: null } };
    const brand = {
      logo: { id: "med_logo", url: "https://cdn.test/logo.png", alt: "Logo", width: 320, height: 80 },
      footerLogo: { id: "med_footer", url: "https://cdn.test/footer.png", alt: "", width: null, height: null },
      favicon: null,
    };
    const live = await resolveRequestTheme({ request: request(), locals: {} }, { theme: published, storeShape: SHAPE, brand });
    expect(live.brand).toEqual(brand);
    expect(live.resolved.brand.logoWidth).toBe(160);

    const draft = { ...storefrontTemplateTheme("boutique"), brand: { logo: "med_draft", logoWidth: 120, footerLogo: null, favicon: "med_icon" } };
    const draftBrand = {
      logo: { id: "med_draft", url: "https://cdn.test/draft.png", alt: "", width: 200, height: 50 },
      footerLogo: null,
      favicon: { id: "med_icon", url: "https://cdn.test/icon.png", alt: "", width: 64, height: 64 },
    };
    resolveThemePreview.mockResolvedValue({ theme: draft, brand: draftBrand });
    const preview = await resolveRequestTheme({ request: request(previewCookie), locals: {} }, { theme: published, storeShape: SHAPE, brand });
    expect(preview.brand).toEqual(draftBrand);

    // An invalid draft renders the default theme, which names no images.
    resolveThemePreview.mockResolvedValue({ theme: { ...draft, version: 99 }, brand: draftBrand });
    const invalid = await resolveRequestTheme({ request: request(previewCookie), locals: {} }, { theme: published, storeShape: SHAPE, brand });
    expect(invalid.theme).toBe(DEFAULT_STOREFRONT_THEME);
    expect(invalid.brand).toEqual({ logo: null, footerLogo: null, favicon: null });
  });

  it("falls back to defaults when nothing resolved the theme (e.g. no Layout)", async () => {
    const fallback = await currentRequestTheme({});
    expect(fallback.theme).toBe(DEFAULT_STOREFRONT_THEME);
    expect(fallback.layout.density).toBe(DEFAULT_STOREFRONT_THEME.tokens.density);
  });
});

describe("readStorefrontBrandAssets", () => {
  const named = { logo: "med_logo", logoWidth: 180, footerLogo: "med_footer", favicon: "med_icon" };

  it("keeps only the images the document names, with a usable URL", () => {
    expect(readStorefrontBrandAssets({
      logo: { id: "med_logo", url: " https://cdn.test/logo.png ", alt: "Logo", width: 300, height: -1 },
      // Another document's image never stands in.
      footerLogo: { id: "med_other", url: "https://cdn.test/other.png", alt: "", width: null, height: null },
      favicon: { id: "med_icon", url: "", alt: "", width: 64, height: 64 },
    }, named)).toEqual({
      logo: { id: "med_logo", url: "https://cdn.test/logo.png", alt: "Logo", width: 300, height: null },
      footerLogo: null,
      favicon: null,
    });
    expect(readStorefrontBrandAssets({ logo: { id: "med_logo", url: "https://cdn.test/logo.png" } }, { ...named, logo: null }).logo).toBeNull();
  });

  it("reads anything that is not brand assets as no images", () => {
    for (const value of [undefined, null, "logo", 42, []]) {
      expect(readStorefrontBrandAssets(value, named)).toEqual({ logo: null, footerLogo: null, favicon: null });
    }
  });
});

describe("readStorefrontTheme", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("accepts every template document as is", () => {
    const withStory = {
      ...storefrontTemplateTheme("boutique"),
      pages: {
        ...storefrontTemplateTheme("boutique").pages,
        home: [
          { id: "story", type: "editorial" as const, version: 1 as const, settings: { layout: "rich-text" as const, heading: "Our story", body: "Made in Dhaka." } },
          { id: "hero", type: "hero" as const, version: 1 as const, settings: { layout: "split" as const, slides: [] } },
        ],
        homeMode: { kind: "sections" as const },
      },
    };
    expect(readStorefrontTheme(withStory)).toEqual(withStory);
  });

  it("uses the default theme whole, never a per-field repair", () => {
    const template = storefrontTemplateTheme("marketplace");
    const invalid = [
      undefined,
      null,
      "{}",
      { ...template, version: 3 },
      { ...template, extra: true },
      { ...template, blocks: { ...template.blocks, header: { variant: "floating", settings: {} } } },
      // The version 3 shape (layout choices instead of blocks).
      { ...template, layout: { header: "classic" } },
      { ...template, tokens: { ...template.tokens, density: "tiny" } },
      // Unreadable text: fails the AA contrast rule.
      { ...template, tokens: { ...template.tokens, colors: { ...template.tokens.colors, foreground: template.tokens.colors.background } } },
    ];
    for (const value of invalid) {
      expect(readStorefrontTheme(value)).toBe(DEFAULT_STOREFRONT_THEME);
    }
  });

  it("reads the store shape strictly and resolves for an empty store otherwise", () => {
    expect(readStoreShape(SHAPE)).toEqual(SHAPE);
    expect(readStoreShape(undefined)).toBe(EMPTY_STORE_SHAPE);
    expect(readStoreShape({ ...SHAPE, skuCount: -1 })).toBe(EMPTY_STORE_SHAPE);
    expect(readStoreShape({ ...SHAPE, extra: true })).toBe(EMPTY_STORE_SHAPE);
  });
});
