import { describe, expect, it } from "vitest";
import {
  STOREFRONT_STYLE_PRESETS,
  sanitizeStorefrontThemeSettings,
  storefrontStylePresetTheme,
  type StorefrontHomepageSection,
} from "@scalius/shared/storefront-theme";
import { moveHomepageSection, sameTheme, selectedStylePreset } from "./theme-settings";

describe("homepage section order", () => {
  const order: StorefrontHomepageSection[] = ["hero", "collections", "categories", "delivery"];

  it("moves a section one place up or down without touching the saved order", () => {
    expect(moveHomepageSection(order, "categories", -1)).toEqual(["hero", "categories", "collections", "delivery"]);
    expect(moveHomepageSection(order, "hero", 1)).toEqual(["collections", "hero", "categories", "delivery"]);
    expect(order).toEqual(["hero", "collections", "categories", "delivery"]);
  });

  it("keeps the order at either end", () => {
    expect(moveHomepageSection(order, "hero", -1)).toEqual(order);
    expect(moveHomepageSection(order, "delivery", 1)).toEqual(order);
  });
});

describe("theme styles", () => {
  it("a new store starts on Classic retail", () => {
    expect(selectedStylePreset(sanitizeStorefrontThemeSettings({}))).toBe("classic");
  });

  it("recognises every style it applies, and each style is a distinct look", () => {
    for (const { key } of STOREFRONT_STYLE_PRESETS) {
      expect(selectedStylePreset(storefrontStylePresetTheme(key))).toBe(key);
    }
  });

  it("still recognises a style when the saved document lists its keys in another order", () => {
    const applied = storefrontStylePresetTheme("marketplace");
    const reloaded = JSON.parse(JSON.stringify({
      layout: { ...applied.layout, productCard: { ...applied.layout.productCard } },
      components: applied.components,
      containerWidth: applied.containerWidth,
      density: applied.density,
      cornerStyle: applied.cornerStyle,
      typography: applied.typography,
      colors: Object.fromEntries(Object.entries(applied.colors).reverse()),
    }));
    expect(sameTheme(reloaded, applied)).toBe(true);
    expect(selectedStylePreset(reloaded)).toBe("marketplace");
  });

  it("drops the selection once the merchant fine-tunes any choice", () => {
    const applied = storefrontStylePresetTheme("boutique");
    const tuned = { ...applied, layout: { ...applied.layout, grid: { ...applied.layout.grid, desktop: 4 as const } } };
    expect(selectedStylePreset(tuned)).toBeNull();
    const reordered = {
      ...applied,
      layout: { ...applied.layout, homepage: moveHomepageSection(applied.layout.homepage, "delivery", -1) },
    };
    expect(selectedStylePreset(reordered)).toBeNull();
  });
});
