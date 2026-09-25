import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_TEMPLATES,
  STOREFRONT_TYPE_PAIRINGS,
  buildStorefrontThemeTokens,
  resolveStorefrontTheme,
  storeShapeFromFacts,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
} from "@scalius/shared/storefront-theme";
import {
  applyTemplate,
  blockFallback,
  blockVariant,
  cardForBackground,
  colorFieldForPath,
  moveSection,
  previewFamily,
  resetTypeTokens,
  resolveThemeForStore,
  sameThemeLook,
  selectedTemplate,
  setBlockVariant,
  setThemeColor,
  setTypeTokens,
  templateTypeTokens,
  themeContrastProblems,
  themeDraftInvalid,
  typePairingPreview,
  typeTokensAreTemplateDefault,
} from "./theme-settings";

const richText: StorefrontSection = {
  id: "story",
  type: "editorial",
  version: 1,
  settings: { layout: "rich-text", heading: "Our story", body: "Handmade in Dhaka." },
};

describe("homepage section order", () => {
  const sections = DEFAULT_STOREFRONT_THEME.pages.home;
  const ids = (list: readonly StorefrontSection[]) => list.map((section) => section.id);

  it("moves a section one place up or down without touching the saved list", () => {
    expect(ids(moveSection(sections, "categories", -1))).toEqual(["hero", "categories", "collections", "delivery"]);
    expect(ids(moveSection(sections, "hero", 1))).toEqual(["collections", "hero", "categories", "delivery"]);
    expect(ids(sections)).toEqual(["hero", "collections", "categories", "delivery"]);
  });

  it("keeps the order at either end", () => {
    expect(moveSection(sections, "hero", -1)).toEqual(sections);
    expect(moveSection(sections, "delivery", 1)).toEqual(sections);
  });

  it("moves a rich text section like any other", () => {
    const withStory = [...sections, richText];
    expect(ids(moveSection(withStory, "story", -1))).toEqual(["hero", "collections", "categories", "story", "delivery"]);
  });
});

describe("templates", () => {
  it("a new store starts on Department mall", () => {
    expect(selectedTemplate(DEFAULT_STOREFRONT_THEME)).toBe("department-mall");
  });

  it("recognises every template it applies, and each template is a distinct look", () => {
    for (const { id } of STOREFRONT_TEMPLATES) {
      expect(selectedTemplate(storefrontTemplateTheme(id))).toBe(id);
    }
  });

  it("selecting a template sets the whole document, a valid one", () => {
    const applied = applyTemplate("heritage-editorial");
    expect(applied).toEqual(storefrontTemplateTheme("heritage-editorial"));
    expect(storefrontThemeDocumentSchema.safeParse(applied).success).toBe(true);
  });

  it("still recognises a template when the saved document lists its keys in another order", () => {
    const applied = storefrontTemplateTheme("marketplace");
    const reloaded = JSON.parse(JSON.stringify({
      pages: applied.pages,
      blocks: Object.fromEntries(Object.entries(applied.blocks).reverse()),
      tokens: { ...applied.tokens, colors: Object.fromEntries(Object.entries(applied.tokens.colors).reverse()) },
      template: applied.template,
      version: applied.version,
    }));
    expect(sameThemeLook(reloaded, applied)).toBe(true);
    expect(selectedTemplate(reloaded)).toBe("marketplace");
  });

  it("drops the selection once the merchant changes any choice, and keeps the template it is based on", () => {
    const applied = storefrontTemplateTheme("boutique");
    const changed = [
      { ...applied, tokens: { ...applied.tokens, density: "compact" as const } },
      { ...applied, pages: { home: moveSection(applied.pages.home, "newsletter", -1) } },
      setThemeColor(applied, "background", "#fafafa"),
      setBlockVariant(applied, "desktopNav", "mega-panel"),
      setBlockVariant(applied, "gallery", "classic"),
    ];
    for (const theme of changed) {
      expect(selectedTemplate(theme)).toBeNull();
      expect(theme.template).toBe("boutique");
      expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
    }
  });

  it("switches a block to another variant at its default settings", () => {
    const theme = setBlockVariant(DEFAULT_STOREFRONT_THEME, "mobileNav", "bottom-tabs");
    expect(theme.blocks.mobileNav).toEqual({
      variant: "bottom-tabs",
      settings: { tabs: ["home", "categories", "search", "cart", "account"], drawer: "accordion" },
    });
    expect(blockVariant(setBlockVariant(theme, "gallery", "stacked"), "gallery")).toBe("stacked");
  });

  it("resolves the draft with the storefront's resolver, and says what a choice falls back to", () => {
    const shape = storeShapeFromFacts({
      productCount: 800, skuCount: 2000, topCategoryCount: 12, categoryDepth: 1,
      menu: [{}, {}, {}], hasCollections: true, hasDeliveryMethods: true,
    });
    const boutique = storefrontTemplateTheme("boutique");
    const resolved = resolveThemeForStore(boutique, shape);
    expect(resolved).toEqual(resolveStorefrontTheme(boutique, shape));
    expect(blockFallback(resolved, "header")).toMatchObject({ requested: "boutique-inline", resolved: "fashion-department" });
    expect(blockFallback(resolved, "desktopNav")).toBeNull();
    expect(blockFallback(resolveThemeForStore(boutique, EMPTY_STORE_SHAPE), "header")).toBeNull();
  });
});

describe("theme colors", () => {
  it("a colour role writes every token of that role", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "text", "#111827");
    expect([theme.tokens.colors.foreground, theme.tokens.colors["card-foreground"], theme.tokens.colors["popover-foreground"]])
      .toEqual(["#111827", "#111827", "#111827"]);
  });

  it("moves the card by the template's own card-to-page step instead of flattening it", () => {
    // Retail: white cards (#ffffff) on warm paper (#fbfaf7), a step of (+4, +5, +8).
    const retail = setThemeColor(storefrontTemplateTheme("department-mall"), "background", "#f0ebe3");
    expect(retail.tokens.colors.background).toBe("#f0ebe3");
    expect(retail.tokens.colors.card).toBe("#f4f0eb");
    expect(retail.tokens.colors.popover).toBe("#f4f0eb");
    // Midnight: raised panels (#141416) over the page (#0a0a0b) keep their lift.
    const midnight = setThemeColor(storefrontTemplateTheme("rounded-tech"), "background", "#101014");
    expect(midnight.tokens.colors.card).toBe("#1a1a1f");
    // A template whose card is its page keeps them equal.
    const fresh = setThemeColor(storefrontTemplateTheme("daily-essentials"), "background", "#fdfdf8");
    expect(fresh.tokens.colors.card).toBe("#fdfdf8");
    expect(cardForBackground(storefrontTemplateTheme("department-mall"), "#ffffff")).toBe("#ffffff");
  });

  it("names unreadable text in plain words on the field that can fix it, and blocks saving", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "buttonText", "#5a5a5a");
    const problems = themeContrastProblems(theme);
    expect(problems.map(({ message, role }) => ({ message, role })))
      .toEqual([{ message: "contrastButtonText", role: "buttonText" }]);
    expect(problems[0]!.ratio).toBeLessThan(4.5);
    expect(themeDraftInvalid(theme)).toBe(true);
    expect(themeDraftInvalid(DEFAULT_STOREFRONT_THEME)).toBe(false);
  });

  it("checks the pairs the chosen blocks paint, such as a coloured price on cards", () => {
    // A grey that passes on the dark page fails on the lighter cards, only once a card paints it.
    const base = setBlockVariant(setThemeColor(storefrontTemplateTheme("rounded-tech"), "buttons", "#7a7a7a"), "card", "standard");
    const onCards = setBlockVariant(base, "card", "spec");
    expect(themeContrastProblems(base).map((problem) => problem.message)).toEqual([]);
    expect(themeContrastProblems(onCards)).toEqual([
      expect.objectContaining({ message: "contrastLinks", role: "buttons" }),
    ]);
  });

  it("one message per problem, even when cards and popovers share it", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "text", "#d4d4d8");
    expect(themeContrastProblems(theme).map((problem) => problem.message)).toEqual(["contrastText"]);
  });

  it("blocks saving a colour that is not #rrggbb, without contrast noise while typing", () => {
    const theme = setThemeColor(DEFAULT_STOREFRONT_THEME, "buttons", "#11");
    expect(themeContrastProblems(theme)).toEqual([]);
    expect(themeDraftInvalid(theme)).toBe(true);
  });

  it("marks the field behind a rejected colour token", () => {
    expect(colorFieldForPath("theme.tokens.colors.primary-foreground")).toBe("theme-color-button-text");
    expect(colorFieldForPath("theme.tokens.colors.card")).toBe("theme-color-background");
    expect(colorFieldForPath("theme.tokens.colors.muted-foreground")).toBe("theme-color-background");
    expect(colorFieldForPath("theme.blocks.header")).toBeUndefined();
  });

  it("adds sections with their default settings", () => {
    expect(storefrontSectionDefault("faq", "faq")).toEqual({ id: "faq", type: "faq", version: 1, settings: { heading: "", items: [] } });
  });
});

describe("typography", () => {
  it("draws each pairing with the stacks the storefront's token CSS sets, under preview names", () => {
    for (const pairing of STOREFRONT_TYPE_PAIRINGS) {
      const theme = { ...DEFAULT_STOREFRONT_THEME, tokens: { ...DEFAULT_STOREFRONT_THEME.tokens, typography: pairing } };
      const css = buildStorefrontThemeTokens(theme);
      const preview = typePairingPreview(pairing);
      // Same families in the same order: the Latin face, the pairing's Bengali face, then the fallbacks.
      expect(preview.heading.stack.replaceAll(previewFamily(""), "")).toBe(css["theme-font-heading"]);
      expect(preview.body.stack.replaceAll(previewFamily(""), "")).toBe(css["theme-font-body"]);
      expect(String(preview.heading.weight)).toBe(css["theme-heading-weight"]);
      expect(preview.heading.stack.startsWith(`"${previewFamily(preview.heading.family)}", "${previewFamily(preview.bangla)}"`)).toBe(true);
    }
  });

  it("falls through to a Bangla family in every pairing", () => {
    for (const pairing of STOREFRONT_TYPE_PAIRINGS) {
      expect(["Noto Sans Bengali", "Noto Serif Bengali", "Hind Siliguri"]).toContain(typePairingPreview(pairing).bangla);
    }
  });

  it("knows each template's type tokens, sets them and puts them back", () => {
    for (const { id } of STOREFRONT_TEMPLATES) {
      const theme = storefrontTemplateTheme(id);
      expect(typeTokensAreTemplateDefault(theme)).toBe(true);
      const { typography, typeScale, headingCase } = theme.tokens;
      expect(templateTypeTokens(theme)).toEqual({ typography, typeScale, headingCase });
    }
    const theme = storefrontTemplateTheme("heritage-editorial");
    const changed = setTypeTokens(theme, { typography: "fresh", headingCase: "sentence" });
    expect(changed.tokens).toEqual({ ...theme.tokens, typography: "fresh", headingCase: "sentence" });
    expect(typeTokensAreTemplateDefault(changed)).toBe(false);
    expect(selectedTemplate(changed)).toBeNull();
    expect(storefrontThemeDocumentSchema.safeParse(changed).success).toBe(true);
    const reset = resetTypeTokens(changed);
    expect(reset).toEqual(theme);
    expect(selectedTemplate(reset)).toBe("heritage-editorial");
  });
});
