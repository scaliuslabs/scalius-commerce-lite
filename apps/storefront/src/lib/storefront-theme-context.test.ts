// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveThemePreview } = vi.hoisted(() => ({ resolveThemePreview: vi.fn() }));
vi.mock("./api/storefront", () => ({ resolveThemePreview }));

import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DENSITY_SPECS,
  storefrontStylePresetTheme,
} from "@scalius/shared/storefront-theme";
import {
  currentRequestTheme,
  readStorefrontTheme,
  resolveRequestTheme,
} from "./storefront-theme-context";
import { THEME_PREVIEW_COOKIE_NAME } from "./theme-preview-cookie";

const request = (cookie = "") => new Request("https://shop.test/", { headers: cookie ? { cookie } : {} });
const previewCookie = `${THEME_PREVIEW_COOKIE_NAME}=tpv_${"a".repeat(48)}`;

describe("request theme", () => {
  beforeEach(() => {
    resolveThemePreview.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("resolves once per request and shares the published theme with every reader", async () => {
    const locals = {};
    const published = storefrontStylePresetTheme("marketplace");
    const first = await resolveRequestTheme({ request: request(), locals }, published);
    expect(first.theme).toEqual(published);
    expect(first.layout.header).toBe("marketplace");
    expect(first.layout.productCard.quickBuy).toBe(true);
    expect(await resolveRequestTheme({ request: request(), locals }, {})).toBe(first);
    expect(await currentRequestTheme(locals)).toBe(first);
    expect(resolveThemePreview).not.toHaveBeenCalled();
  });

  it("renders the dashboard draft while a valid preview cookie is present", async () => {
    resolveThemePreview.mockResolvedValue({ theme: storefrontStylePresetTheme("heritage") });
    const resolved = await resolveRequestTheme(
      { request: request(previewCookie), locals: {} },
      storefrontStylePresetTheme("classic"),
    );
    expect(resolveThemePreview).toHaveBeenCalledWith(`tpv_${"a".repeat(48)}`);
    expect(resolved.previewToken).toBe(`tpv_${"a".repeat(48)}`);
    expect(resolved.layout.productPage).toEqual({ gallery: "stacked", thumbnails: "below" });
    expect(resolved.layout.density).toBe("comfortable");
    expect(resolved.layout.grid).toBe(STOREFRONT_DENSITY_SPECS.comfortable);
  });

  it("renders the default theme whole for an invalid preview draft", async () => {
    const draft = storefrontStylePresetTheme("boutique");
    resolveThemePreview.mockResolvedValue({ theme: { ...draft, layout: { ...draft.layout, grid: "dense" } } });
    const resolved = await resolveRequestTheme(
      { request: request(previewCookie), locals: {} },
      storefrontStylePresetTheme("marketplace"),
    );
    expect(resolved.theme).toBe(DEFAULT_STOREFRONT_THEME);
  });

  it("falls back to defaults when nothing resolved the theme (e.g. no Layout)", async () => {
    const fallback = await currentRequestTheme({});
    expect(fallback.theme).toBe(DEFAULT_STOREFRONT_THEME);
    expect(fallback.layout.density).toBe(DEFAULT_STOREFRONT_THEME.layout.density);
  });
});

describe("readStorefrontTheme", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("accepts every Style preset document as is", () => {
    const custom = {
      ...storefrontStylePresetTheme("beauty"),
      mode: "custom" as const,
      sections: [
        { id: "story", type: "rich_text" as const, version: 1 as const, settings: { heading: "Our story", body: "Made in Dhaka." } },
        { id: "hero", type: "hero" as const, version: 1 as const, settings: {} },
      ],
    };
    expect(readStorefrontTheme(custom)).toEqual(custom);
  });

  it("uses the default theme whole, never a per-field repair", () => {
    const preset = storefrontStylePresetTheme("midnight");
    const invalid = [
      undefined,
      null,
      "{}",
      { ...preset, version: 1 },
      { ...preset, extra: true },
      { ...preset, layout: { ...preset.layout, header: "floating" } },
      // An older document shape (a grid choice instead of density).
      { ...preset, layout: { ...preset.layout, grid: "standard" } },
      { ...preset, layout: { ...preset.layout, density: "airy" } },
      // Unreadable text: fails the AA contrast rule.
      { ...preset, tokens: { ...preset.tokens, colors: { ...preset.tokens.colors, foreground: "#0a0a0a" } } },
      // A configured document must carry every theme section.
      { ...preset, sections: preset.sections.slice(1) },
    ];
    for (const value of invalid) {
      expect(readStorefrontTheme(value)).toBe(DEFAULT_STOREFRONT_THEME);
    }
  });
});
