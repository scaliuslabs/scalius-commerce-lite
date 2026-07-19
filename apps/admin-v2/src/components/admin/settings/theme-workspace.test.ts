import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

import {
  buildThemePreviewHandoffUrl,
  buildStorefrontReviewLinks,
  describeThemeDraftChanges,
  normalizeThemePreviewDevice,
  normalizeThemePreviewPath,
  normalizeThemeWorkspaceSection,
} from "./theme-workspace";

describe("theme workspace", () => {
  it("normalizes unknown sections to the design system", () => {
    expect(normalizeThemeWorkspaceSection("colors")).toBe("colors");
    expect(normalizeThemeWorkspaceSection("unknown")).toBe("system");
    expect(normalizeThemeWorkspaceSection(undefined)).toBe("system");
  });

  it("keeps preview device and safe storefront route choices reloadable", () => {
    expect(normalizeThemePreviewDevice("mobile")).toBe("mobile");
    expect(normalizeThemePreviewDevice("watch")).toBe("desktop");
    expect(normalizeThemePreviewPath("/products/linen-shirt")).toBe(
      "/products/linen-shirt",
    );
    expect(normalizeThemePreviewPath("/about-us")).toBe("/about-us");
    expect(normalizeThemePreviewPath("/api/v1/products")).toBe("/");
    expect(normalizeThemePreviewPath("//outside.example")).toBe("/");
    expect(normalizeThemePreviewPath("/products/a?receipt=secret")).toBe("/");
  });

  it("builds a bearer-free storefront handoff URL", () => {
    const url = buildThemePreviewHandoffUrl(
      "https://shop.example.com/store",
      "/products/linen-shirt",
      "mobile",
    );
    expect(url).toBe(
      "https://shop.example.com/theme-preview/handoff?path=%2Fproducts%2Flinen-shirt&device=mobile",
    );
    expect(url).not.toContain("token");
    expect(buildThemePreviewHandoffUrl("javascript:alert(1)", "/", "full")).toBeNull();
  });

  it("describes semantic and color changes against the published revision", () => {
    expect(
      describeThemeDraftChanges(DEFAULT_STOREFRONT_THEME_SETTINGS, {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        density: "compact",
        components: {
          ...DEFAULT_STOREFRONT_THEME_SETTINGS.components,
          cards: "elevated",
        },
        colors: { primary: "#123456" },
      }),
    ).toEqual([
      {
        key: "density",
        label: "Density",
        published: "Comfortable",
        draft: "Compact",
      },
      {
        key: "cards",
        label: "Product cards",
        published: "Bordered",
        draft: "Elevated",
      },
      {
        key: "colors",
        label: "Semantic colors",
        published: "0 overrides",
        draft: "1 changed · 1 overrides",
      },
    ]);
  });

  it("keeps an invalid blocked color visible in the draft summary", () => {
    expect(
      describeThemeDraftChanges(DEFAULT_STOREFRONT_THEME_SETTINGS, {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: { primary: "not-a-safe-color" },
      }),
    ).toEqual([
      {
        key: "colors",
        label: "Semantic colors",
        published: "0 overrides",
        draft: "1 changed · 1 overrides",
      },
    ]);
  });

  it("builds only safe absolute published-route review links", () => {
    expect(buildStorefrontReviewLinks("https://shop.example.com")).toEqual([
      {
        label: "Home",
        description: "Header, hero, product cards, buttons, and footer",
        href: "https://shop.example.com/",
      },
      {
        label: "Search",
        description: "Fields, filters, empty states, and listing density",
        href: "https://shop.example.com/search",
      },
    ]);
    expect(buildStorefrontReviewLinks("javascript:alert(1)")).toEqual([]);
    expect(buildStorefrontReviewLinks("https://user:secret@shop.example.com")).toEqual([]);
    expect(buildStorefrontReviewLinks("/store")).toEqual([]);
  });
});
