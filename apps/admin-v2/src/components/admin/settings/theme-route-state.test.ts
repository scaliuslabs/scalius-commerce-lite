import { describe, expect, it } from "vitest";

import {
  normalizeThemePreviewDevice,
  normalizeThemePreviewPath,
  normalizeThemeWorkspaceSection,
  THEME_PREVIEW_DEVICES,
  THEME_WORKSPACE_SECTIONS,
} from "./theme-route-state";
import {
  normalizeThemePreviewDevice as legacyNormalizeThemePreviewDevice,
  normalizeThemePreviewPath as legacyNormalizeThemePreviewPath,
  normalizeThemeWorkspaceSection as legacyNormalizeThemeWorkspaceSection,
} from "./theme-workspace";

describe("theme route state", () => {
  it("preserves workspace and device validation defaults", () => {
    expect(THEME_WORKSPACE_SECTIONS.map(({ value }) => value)).toEqual([
      "system",
      "colors",
      "review",
    ]);
    expect(THEME_PREVIEW_DEVICES).toEqual(["full", "desktop", "mobile"]);
    expect(normalizeThemeWorkspaceSection("review")).toBe("review");
    expect(normalizeThemeWorkspaceSection(["review"])).toBe("system");
    expect(normalizeThemePreviewDevice("full")).toBe("full");
    expect(normalizeThemePreviewDevice("watch")).toBe("desktop");
  });

  it("accepts only buyer-safe storefront preview paths", () => {
    expect(normalizeThemePreviewPath(" /products/linen-shirt ")).toBe(
      "/products/linen-shirt",
    );
    expect(normalizeThemePreviewPath("/categories/summer_2026")).toBe(
      "/categories/summer_2026",
    );
    expect(normalizeThemePreviewPath("/collections/collection-1")).toBe(
      "/collections/collection-1",
    );
    expect(normalizeThemePreviewPath("/about-us")).toBe("/about-us");
    expect(normalizeThemePreviewPath("/search")).toBe("/search");
    expect(normalizeThemePreviewPath("//outside.example")).toBe("/");
    expect(normalizeThemePreviewPath("/products/a?receipt=secret")).toBe("/");
    expect(normalizeThemePreviewPath("/products%2Fsecret")).toBe("/");
    expect(normalizeThemePreviewPath("/checkout")).toBe("/");
  });

  it("keeps the original workspace module exports as identical aliases", () => {
    expect(legacyNormalizeThemeWorkspaceSection).toBe(
      normalizeThemeWorkspaceSection,
    );
    expect(legacyNormalizeThemePreviewDevice).toBe(normalizeThemePreviewDevice);
    expect(legacyNormalizeThemePreviewPath).toBe(normalizeThemePreviewPath);
  });
});
