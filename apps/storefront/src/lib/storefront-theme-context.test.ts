// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveThemePreview } = vi.hoisted(() => ({ resolveThemePreview: vi.fn() }));
vi.mock("./api/storefront", () => ({ resolveThemePreview }));

import { DEFAULT_STOREFRONT_THEME_SETTINGS, storefrontStylePresetTheme } from "@scalius/shared/storefront-theme";
import { currentRequestTheme, resolveRequestTheme } from "./storefront-theme-context";
import { THEME_PREVIEW_COOKIE_NAME } from "./theme-preview-cookie";

const request = (cookie = "") => new Request("https://shop.test/", { headers: cookie ? { cookie } : {} });

describe("request theme", () => {
  beforeEach(() => resolveThemePreview.mockReset());

  it("resolves once per request and shares the published theme with every reader", async () => {
    const locals = {};
    const published = storefrontStylePresetTheme("marketplace");
    const first = await resolveRequestTheme({ request: request(), locals }, published);
    expect(first.theme.layout.header).toBe("marketplace");
    expect(await resolveRequestTheme({ request: request(), locals }, {})).toBe(first);
    expect(await currentRequestTheme(locals)).toBe(first.theme);
    expect(resolveThemePreview).not.toHaveBeenCalled();
  });

  it("renders the dashboard draft while a valid preview cookie is present", async () => {
    const draft = storefrontStylePresetTheme("editorial");
    resolveThemePreview.mockResolvedValue({ theme: draft });
    const token = `tpv_${"a".repeat(48)}`;
    const locals = {};
    const resolved = await resolveRequestTheme(
      { request: request(`${THEME_PREVIEW_COOKIE_NAME}=${token}`), locals },
      storefrontStylePresetTheme("classic"),
    );
    expect(resolveThemePreview).toHaveBeenCalledWith(token);
    expect(resolved.previewToken).toBe(token);
    expect(resolved.theme.layout.productPage.gallery).toBe("stacked");
  });

  it("falls back to defaults when nothing resolved the theme (e.g. no Layout)", async () => {
    expect(await currentRequestTheme({})).toEqual(DEFAULT_STOREFRONT_THEME_SETTINGS);
  });
});
