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
    expect(first.resolved.blocks.card.variant).toBe("marketplace");
    expect(await resolveRequestTheme({ request: request(), locals }, {})).toBe(first);
    expect(await currentRequestTheme(locals)).toBe(first);
    expect(resolveThemePreview).not.toHaveBeenCalled();
  });

  it("resolves with the same resolver and store shape the dashboard uses", async () => {
    // The layout read serves JSON; the dashboard resolves its in-memory draft.
    const theme = storefrontTemplateTheme("boutique");
    const fromApi = JSON.parse(JSON.stringify({ theme, storeShape: SHAPE })) as { theme: unknown; storeShape: unknown };
    const resolved = await resolveRequestTheme({ request: request(), locals: {} }, fromApi);
    expect(resolved.resolved).toEqual(resolveStorefrontTheme(theme, SHAPE));
    // A 900-SKU catalogue gets a header with a visible search.
    expect(resolved.resolved.blocks.header).toMatchObject({ variant: "fashion-department", requested: "boutique-inline" });
    expect(requestThemeFor(theme, SHAPE).resolved).toEqual(resolved.resolved);
  });

  it("renders the dashboard draft while a valid preview cookie is present", async () => {
    resolveThemePreview.mockResolvedValue({ theme: storefrontTemplateTheme("heritage-editorial") });
    const resolved = await resolveRequestTheme(
      { request: request(previewCookie), locals: {} },
      { theme: DEFAULT_STOREFRONT_THEME, storeShape: SHAPE },
    );
    expect(resolveThemePreview).toHaveBeenCalledWith(`tpv_${"a".repeat(48)}`);
    expect(resolved.previewToken).toBe(`tpv_${"a".repeat(48)}`);
    expect(resolved.theme.template).toBe("heritage-editorial");
    expect(resolved.layout.productPage).toEqual({ gallery: "beside", thumbnails: "below" });
    expect(resolved.layout.productCard.imageRatio).toBe("portrait");
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

  it("falls back to defaults when nothing resolved the theme (e.g. no Layout)", async () => {
    const fallback = await currentRequestTheme({});
    expect(fallback.theme).toBe(DEFAULT_STOREFRONT_THEME);
    expect(fallback.layout.density).toBe(DEFAULT_STOREFRONT_THEME.tokens.density);
  });
});

describe("readStorefrontTheme", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("accepts every template document as is", () => {
    const withStory = {
      ...storefrontTemplateTheme("fashion-value"),
      pages: {
        home: [
          { id: "story", type: "editorial" as const, version: 1 as const, settings: { layout: "rich-text" as const, heading: "Our story", body: "Made in Dhaka." } },
          { id: "hero", type: "hero" as const, version: 1 as const, settings: { layout: "split" as const } },
        ],
      },
    };
    expect(readStorefrontTheme(withStory)).toEqual(withStory);
  });

  it("uses the default theme whole, never a per-field repair", () => {
    const template = storefrontTemplateTheme("rounded-tech");
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
      { ...template, tokens: { ...template.tokens, colors: { ...template.tokens.colors, foreground: "#0a0a0a" } } },
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
