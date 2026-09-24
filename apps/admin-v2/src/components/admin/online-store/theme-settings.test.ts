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
  colorFieldForPath,
  moveSection,
  sameThemeLook,
  selectedStylePreset,
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
  });
});

describe("theme colors", () => {
  it("a colour role writes every token of that role", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "background", "#fffbeb");
    expect([theme.tokens.colors.background, theme.tokens.colors.card, theme.tokens.colors.popover])
      .toEqual(["#fffbeb", "#fffbeb", "#fffbeb"]);
    expect(DEFAULT_STOREFRONT_THEME.tokens.colors.background).toBe("#ffffff");
  });

  it("names unreadable text in plain words on the field that can fix it, and blocks saving", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "buttonText", "#7ad08f");
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
