import { describe, expect, it } from "vitest";
import { moveItem } from "./theme-editor/editor-state";
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
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  applyTemplate,
  blockFallback,
  blockVariant,
  cardForBackground,
  previewFamily,
  resetTypeTokens,
  resolveThemeForStore,
  selectedTemplate,
  setBlockVariant,
  setThemeColor,
  setTypeTokens,
  templateTypeTokens,
  themeContrastProblems,
  themeDraftInvalid,
  toggleProductModule,
  typePairingPreview,
  typeTokensAreTemplateDefault,
} from "./theme-settings";

const SLIDE = { image: "media_slide", focalPoint: { x: 40, y: 60 }, alt: "Honey jars", heading: "Eid sale", link: "/collections/sale" };

/** A theme with the merchant's content filled in: logo, words, slides, categories and a one-product homepage. */
function withContent(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return {
    ...theme,
    brand: { logo: "media_logo", logoWidth: 160, footerLogo: null, favicon: "media_icon" },
    blocks: {
      ...theme.blocks,
      // The template's own bar (an announcement where it has none), with the merchant's words.
      topBar: {
        variant: theme.blocks.topBar.variant === "none" ? "announcement" : theme.blocks.topBar.variant,
        settings: { text: "Free delivery in Dhaka", link: "/collections/sale" },
      },
      footer: {
        ...theme.blocks.footer,
        settings: { ...theme.blocks.footer.settings, tagline: "Pure honey", about: "From the Sundarbans.", copyright: "Mou Ghor" },
      },
    } as StorefrontThemeDocument["blocks"],
    pages: {
      ...theme.pages,
      homeMode: { kind: "product", productId: "prod_honey" },
      home: theme.pages.home.map((section) => {
        if (section.type === "hero") return { ...section, settings: { ...section.settings, slides: [SLIDE] } };
        if (section.type === "category-tiles") return { ...section, settings: { ...section.settings, categoryIds: ["cat_honey", "cat_ghee"] } };
        return section;
      }),
    },
  };
}


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
    const applied = applyTemplate("boutique", DEFAULT_STOREFRONT_THEME);
    expect(applied).toEqual(storefrontTemplateTheme("boutique"));
    expect(storefrontThemeDocumentSchema.safeParse(applied).success).toBe(true);
  });

  it("keeps the merchant's content when another template replaces the look", () => {
    const current = withContent(storefrontTemplateTheme("department-mall"));
    const applied = applyTemplate("daily-essentials", current);
    expect(selectedTemplate(applied)).toBe("daily-essentials");
    expect(applied.blocks.header).toEqual(storefrontTemplateTheme("daily-essentials").blocks.header);
    expect(applied.brand).toEqual(current.brand);
    expect(applied.pages.homeMode).toEqual({ kind: "product", productId: "prod_honey" });
    expect(applied.blocks.footer.settings).toMatchObject({ tagline: "Pure honey", about: "From the Sundarbans.", copyright: "Mou Ghor" });
    const hero = applied.pages.home.find((section) => section.type === "hero");
    expect(hero?.type === "hero" && hero.settings.slides).toEqual([SLIDE]);
    const tiles = applied.pages.home.find((section) => section.type === "category-tiles");
    expect(tiles?.type === "category-tiles" && tiles.settings.categoryIds).toEqual(["cat_honey", "cat_ghee"]);
    expect(storefrontThemeDocumentSchema.safeParse(applied).success).toBe(true);
  });

  it("filled-in content never makes a template custom", () => {
    expect(selectedTemplate(withContent(storefrontTemplateTheme("department-mall")))).toBe("department-mall");
  });

  it("lets a merchant change the purchase panel without changing the gallery", () => {
    const theme = storefrontTemplateTheme("boutique");
    const changed = setBlockVariant(theme, "buyBox", "heritage");
    expect(blockVariant(changed, "buyBox")).toBe("heritage");
    expect(changed.blocks.product.gallery).toEqual(theme.blocks.product.gallery);
    expect(storefrontThemeDocumentSchema.safeParse(changed).success).toBe(true);
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
    expect(selectedTemplate(reloaded)).toBe("marketplace");
  });

  it("drops the selection once the merchant changes any choice, and keeps the template it is based on", () => {
    const applied = storefrontTemplateTheme("boutique");
    const changed = [
      { ...applied, tokens: { ...applied.tokens, density: "compact" as const } },
      { ...applied, pages: { ...applied.pages, home: moveItem(applied.pages.home, applied.pages.home.findIndex((section) => section.id === "testimonials"), applied.pages.home.findIndex((section) => section.id === "testimonials") - 1) } },
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

  it("keeps the announcement's and footer's words when the bar or footer changes", () => {
    const theme = withContent(DEFAULT_STOREFRONT_THEME);
    expect(theme.blocks.topBar.variant).toBe("utility");
    const banner = setBlockVariant(theme, "topBar", "announcement");
    expect(banner.blocks.topBar).toEqual({ variant: "announcement", settings: { text: "Free delivery in Dhaka", link: "/collections/sale" } });
    expect(setBlockVariant(banner, "topBar", "none").blocks.topBar).toEqual({ variant: "none", settings: {} });
    const footer = setBlockVariant(theme, "footer", "brand-black");
    expect(footer.blocks.footer.settings).toEqual({ tagline: "Pure honey", about: "From the Sundarbans.", copyright: "Mou Ghor" });
  });

  it("switches a block to another variant at its default settings", () => {
    const theme = setBlockVariant(DEFAULT_STOREFRONT_THEME, "mobileNav", "bottom-tabs");
    expect(theme.blocks.mobileNav).toEqual({
      variant: "bottom-tabs",
      settings: { tabs: ["home", "categories", "search", "cart", "account"], drawer: "accordion" },
    });
    expect(blockVariant(setBlockVariant(theme, "gallery", "stacked"), "gallery")).toBe("stacked");
  });

  it("resolves the draft with the storefront's resolver and keeps a chosen header", () => {
    const shape = storeShapeFromFacts({
      productCount: 800, skuCount: 2000, topCategoryCount: 12, categoryDepth: 1,
      menu: [{}, {}, {}], hasCollections: true, hasDeliveryMethods: true,
    });
    const boutique = storefrontTemplateTheme("boutique");
    const resolved = resolveThemeForStore(boutique, shape);
    expect(resolved).toEqual(resolveStorefrontTheme(boutique, shape));
    expect(resolved.blocks.header.variant).toBe("inline-nav");
    expect(blockFallback(resolved, "header")).toBeNull();
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

  it("lets merchants recolour the marketplace search button without changing purchase buttons", () => {
    const base = storefrontTemplateTheme("marketplace");
    const theme = setThemeColor(setThemeColor(base, "highlight", "#123456"), "highlightText", "#ffffff");
    expect(theme.tokens.colors.accent).toBe("#123456");
    expect(theme.tokens.colors["accent-foreground"]).toBe("#ffffff");
    expect(theme.tokens.colors.primary).toBe(base.tokens.colors.primary);
    expect(themeDraftInvalid(theme)).toBe(false);
  });

  it("moves the card by the template's own card-to-page step instead of flattening it", () => {
    // Retail: white cards (#ffffff) on a white page, so the card follows the page.
    const retail = setThemeColor(storefrontTemplateTheme("department-mall"), "background", "#f0ebe3");
    expect(retail.tokens.colors.background).toBe("#f0ebe3");
    expect(retail.tokens.colors.card).toBe("#f0ebe3");
    expect(retail.tokens.colors.popover).toBe("#f0ebe3");
    // Boutique: linen cards on the same linen page stay equal as well. Every
    // preset's card is its page, so the step is zero for all five.
    const boutique = setThemeColor(storefrontTemplateTheme("boutique"), "background", "#f0ebe3");
    expect(boutique.tokens.colors.card).toBe("#f0ebe3");
    // Marketplace uses one continuous dark surface.
    const midnight = setThemeColor(storefrontTemplateTheme("marketplace"), "background", "#101014");
    expect(midnight.tokens.colors.card).toBe("#101014");
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

  it("keeps unreadable button and link colours blocked across card settings", () => {
    const base = setThemeColor(storefrontTemplateTheme("department-mall"), "buttons", "#7a7a7a");
    const onCards = { ...base, blocks: { ...base.blocks, card: { variant: "standard", settings: { facts: "key-specs", action: "quick-add", hoverImage: true } } } } as StorefrontThemeDocument;
    expect(themeContrastProblems(base).map((problem) => problem.message)).toEqual(["contrastButtonText", "contrastLinks"]);
    expect(themeContrastProblems(onCards).map((problem) => problem.message)).toEqual(["contrastButtonText", "contrastLinks"]);
  });

  it("blocks saving a sale colour the cards cannot show, with the error-colour message on its field", () => {
    // AA on the white page (4.83:1), 4.09:1 on a grey card: the card's sale price would be unreadable.
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    theme.tokens.colors = { ...theme.tokens.colors, background: "#ffffff", card: "#ececec", destructive: "#dc2626" };
    const problems = themeContrastProblems(theme);
    expect(problems.map(({ message, role }) => ({ message, role }))).toEqual([{ message: "contrastError", role: "background" }]);
    expect(problems[0]!.ratio).toBeLessThan(4.5);
    expect(themeDraftInvalid(theme)).toBe(true);
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

  it("blocks saving an announcement link that is not usable, and a one-product homepage without its product", () => {
    const theme = withContent(DEFAULT_STOREFRONT_THEME);
    expect(themeDraftInvalid(theme)).toBe(false);
    const typed = { ...theme, blocks: { ...theme.blocks, topBar: { variant: "announcement", settings: { text: "Sale", link: "sale page" } } } } as StorefrontThemeDocument;
    expect(themeDraftInvalid(typed)).toBe(true);
    expect(themeDraftInvalid({ ...theme, pages: { ...theme.pages, homeMode: { kind: "product", productId: "" } } })).toBe(true);
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
    const theme = storefrontTemplateTheme("boutique");
    const changed = setTypeTokens(theme, { typography: "fresh", headingCase: "sentence" });
    expect(changed.tokens).toEqual({ ...theme.tokens, typography: "fresh", headingCase: "sentence" });
    expect(typeTokensAreTemplateDefault(changed)).toBe(false);
    expect(selectedTemplate(changed)).toBeNull();
    expect(storefrontThemeDocumentSchema.safeParse(changed).success).toBe(true);
    const reset = resetTypeTokens(changed);
    expect(reset).toEqual(theme);
    expect(selectedTemplate(reset)).toBe("boutique");
  });
});

describe("product page modules in the theme editor", () => {
  it("shows a module at its registry place and hides it again", () => {
    const below = storefrontTemplateTheme("department-mall").blocks.product.below;
    expect(below).toEqual(["description", "reviews", "related"]);
    const bundled = toggleProductModule(below, "frequently-bought-together", true);
    expect(bundled).toEqual(["frequently-bought-together", "description", "reviews", "related"]);
    const everything = (["frequently-bought-together", "compare-similar", "policies", "recently-viewed"] as const).reduce((list, module) => toggleProductModule(list, module, true), below);
    expect(everything).toEqual(["frequently-bought-together", "description", "compare-similar", "reviews", "policies", "related", "recently-viewed"]);
    expect(toggleProductModule(everything, "policies", false)).not.toContain("policies");
    // Turning a present module on again keeps one copy.
    expect(toggleProductModule(bundled, "frequently-bought-together", true).filter((each) => each === "frequently-bought-together")).toHaveLength(1);
    const theme = storefrontTemplateTheme("department-mall");
    theme.blocks.product.below = everything;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
  });
});
