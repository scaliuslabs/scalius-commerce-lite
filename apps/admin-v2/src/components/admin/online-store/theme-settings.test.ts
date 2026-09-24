import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_STYLE_PRESETS,
  storefrontStylePresetTheme,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
} from "@scalius/shared/storefront-theme";
import {
  applyStylePreset,
  closestStylePreset,
  colorFieldForPath,
  moveSection,
  sameThemeLook,
  selectedStylePreset,
  cardForBackground,
  setThemeColor,
  themeContrastProblems,
  themeDraftInvalid,
} from "./theme-settings";

const richText: StorefrontSection = {
  id: "story",
  type: "rich_text",
  version: 1,
  settings: { heading: "Our story", body: "Handmade in Dhaka." },
};

describe("homepage section order", () => {
  const sections = storefrontStylePresetTheme("classic").sections;
  const types = (list: readonly StorefrontSection[]) => list.map((section) => section.type);

  it("moves a section one place up or down without touching the saved list", () => {
    expect(types(moveSection(sections, "categories", -1))).toEqual(["hero", "categories", "collections", "delivery"]);
    expect(types(moveSection(sections, "hero", 1))).toEqual(["collections", "hero", "categories", "delivery"]);
    expect(types(sections)).toEqual(["hero", "collections", "categories", "delivery"]);
  });

  it("keeps the order at either end", () => {
    expect(moveSection(sections, "hero", -1)).toEqual(sections);
    expect(moveSection(sections, "delivery", 1)).toEqual(sections);
  });

  it("moves a builder section like any other", () => {
    const withStory = [...sections, richText];
    expect(types(moveSection(withStory, "story", -1))).toEqual(["hero", "collections", "categories", "rich_text", "delivery"]);
  });
});

describe("theme styles", () => {
  it("a new store starts on Classic retail", () => {
    expect(selectedStylePreset(DEFAULT_STOREFRONT_THEME)).toBe("classic");
  });

  it("recognises every style it applies, and each style is a distinct look", () => {
    for (const { key } of STOREFRONT_STYLE_PRESETS) {
      expect(selectedStylePreset(storefrontStylePresetTheme(key))).toBe(key);
    }
  });

  it("selecting a style sets the whole document, a valid configured one", () => {
    const tuned = setThemeColor(storefrontStylePresetTheme("classic"), "buttons", "#1d4ed8");
    const applied = applyStylePreset({ ...tuned, layout: { ...tuned.layout, footer: "compact" } }, "heritage");
    expect(applied).toEqual(storefrontStylePresetTheme("heritage"));
    expect(storefrontThemeDocumentSchema.safeParse(applied).success).toBe(true);
  });

  it("keeps builder sections in place when a style is selected", () => {
    const classic = storefrontStylePresetTheme("classic");
    const theme = { ...classic, sections: [classic.sections[0]!, richText, ...classic.sections.slice(1)] };
    const applied = applyStylePreset(theme, "daily");
    expect(applied.sections.map((section) => section.id)).toEqual(["categories", "story", "hero", "delivery", "collections"]);
    expect(selectedStylePreset(applied)).toBe("daily");
  });

  it("still recognises a style when the saved document lists its keys in another order", () => {
    const applied = storefrontStylePresetTheme("marketplace");
    const reloaded = JSON.parse(JSON.stringify({
      sections: applied.sections,
      layout: Object.fromEntries(Object.entries(applied.layout).reverse()),
      tokens: { ...applied.tokens, colors: Object.fromEntries(Object.entries(applied.tokens.colors).reverse()) },
      mode: applied.mode,
      version: applied.version,
    }));
    expect(sameThemeLook(reloaded, applied)).toBe(true);
    expect(selectedStylePreset(reloaded)).toBe("marketplace");
  });

  it("drops the selection once the merchant changes any choice", () => {
    const applied = storefrontStylePresetTheme("boutique");
    expect(selectedStylePreset({ ...applied, layout: { ...applied.layout, density: "compact" } })).toBeNull();
    expect(selectedStylePreset({ ...applied, sections: moveSection(applied.sections, "delivery", -1) })).toBeNull();
    expect(selectedStylePreset(setThemeColor(applied, "background", "#fafafa"))).toBeNull();
    expect(selectedStylePreset({ ...applied, layout: { ...applied.layout, navigation: "sidebar" } })).toBeNull();
    expect(selectedStylePreset({ ...applied, layout: { ...applied.layout, mobileNavigation: "tabs" } })).toBeNull();
  });

  it("tells apart Styles that differ only in navigation, and names the one a tuned theme started from", () => {
    const marketplace = storefrontStylePresetTheme("marketplace");
    const daily = storefrontStylePresetTheme("daily");
    // Same header, footer, cards, density and product page; the menu differs.
    const { navigation: _m, ...marketplaceLayout } = marketplace.layout;
    const { navigation: _d, ...dailyLayout } = daily.layout;
    expect(marketplaceLayout).toEqual(dailyLayout);
    expect(sameThemeLook(marketplace, { ...marketplace, layout: daily.layout })).toBe(false);

    // Daily's colours and order with Marketplace's menu still started from Daily.
    const tuned = { ...daily, layout: { ...daily.layout, navigation: marketplace.layout.navigation } };
    expect(selectedStylePreset(tuned)).toBeNull();
    expect(closestStylePreset(tuned)).toBe("daily");
  });
});

describe("theme colors", () => {
  it("a colour role writes every token of that role", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "text", "#111827");
    expect([theme.tokens.colors.foreground, theme.tokens.colors["card-foreground"], theme.tokens.colors["popover-foreground"]])
      .toEqual(["#111827", "#111827", "#111827"]);
  });

  it("moves the card by the Style's own card-to-page step instead of flattening it", () => {
    // Retail: white cards (#ffffff) on warm paper (#fbfaf7), a step of (+4, +5, +8).
    const retail = setThemeColor(storefrontStylePresetTheme("classic"), "background", "#f0ebe3");
    expect(retail.tokens.colors.background).toBe("#f0ebe3");
    expect(retail.tokens.colors.card).toBe("#f4f0eb");
    expect(retail.tokens.colors.popover).toBe("#f4f0eb");
    // Midnight: raised panels (#141416) over the page (#0a0a0b) keep their lift.
    const midnight = setThemeColor(storefrontStylePresetTheme("midnight"), "background", "#101014");
    expect(midnight.tokens.colors.card).toBe("#1a1a1f");
    // A Style whose card is its page keeps them equal.
    const fresh = setThemeColor(storefrontStylePresetTheme("daily"), "background", "#fdfdf8");
    expect(fresh.tokens.colors.card).toBe("#fdfdf8");
    expect(cardForBackground(storefrontStylePresetTheme("classic"), "#ffffff")).toBe("#ffffff");
  });

  it("names unreadable text in plain words on the field that can fix it, and blocks saving", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "buttonText", "#5a5a5a");
    const problems = themeContrastProblems(theme.tokens.colors);
    expect(problems.map(({ message, role }) => ({ message, role })))
      .toEqual([{ message: "contrastButtonText", role: "buttonText" }]);
    expect(problems[0]!.ratio).toBeLessThan(4.5);
    expect(themeDraftInvalid(theme)).toBe(true);
    expect(themeDraftInvalid(DEFAULT_STOREFRONT_THEME)).toBe(false);
  });

  it("one message per problem, even when cards and popovers share it", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "text", "#d4d4d8");
    expect(themeContrastProblems(theme.tokens.colors).map((problem) => problem.message)).toEqual(["contrastText"]);
  });

  it("blocks saving a colour that is not #rrggbb, without contrast noise while typing", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "buttons", "#11");
    expect(themeContrastProblems(theme.tokens.colors)).toEqual([]);
    expect(themeDraftInvalid(theme)).toBe(true);
  });

  it("marks the field behind a rejected colour token", () => {
    expect(colorFieldForPath("theme.tokens.colors.primary-foreground")).toBe("theme-color-button-text");
    expect(colorFieldForPath("theme.tokens.colors.card")).toBe("theme-color-background");
    expect(colorFieldForPath("theme.tokens.colors.muted-foreground")).toBe("theme-color-background");
    expect(colorFieldForPath("theme.layout.header")).toBeUndefined();
  });
});
