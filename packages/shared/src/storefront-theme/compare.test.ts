import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme } from "./templates";
import { compareThemeDocuments, themeDocumentChangeSchema } from "./compare";
import { storefrontSectionDefault } from "./sections";

describe("theme changes", () => {
  it("ignores key order and reports added, removed, changed and reordered sections", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.tokens = Object.fromEntries(Object.entries(after.tokens).reverse()) as typeof after.tokens;
    expect(compareThemeDocuments(before, after)).toEqual([]);
    const [first, second, ...rest] = before.pages.home;
    if (!first || !second) throw new Error("Need two default sections.");
    after.pages.home = [second, { ...first, hidden: true }, storefrontSectionDefault("faq", "questions"), ...rest.slice(1)];
    const changes = compareThemeDocuments(before, after);
    expect(changes).toEqual([
      ...(rest[0] ? [{ kind: "section-removed", page: "home", sectionId: rest[0].id, sectionType: rest[0].type }] : []),
      { kind: "section-changed", page: "home", sectionId: first.id, sectionType: first.type },
      { kind: "section-added", page: "home", sectionId: "questions", sectionType: "faq" },
      { kind: "sections-reordered", page: "home" },
    ]);
    for (const change of changes) expect(themeDocumentChangeSchema.parse(change)).toEqual(change);
  });

  it("names the announcement bar apart from the header", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.blocks.topBar = { variant: "announcement", settings: { text: "Eid sale", link: null } };
    expect(compareThemeDocuments(before, after)).toEqual([{ kind: "settings-changed", area: "announcement" }]);
  });

  it("reports a template's section changes under template/<kind>", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.pages.templates.product = { sections: [storefrontSectionDefault("faq", "questions")], main: 0 };
    expect(compareThemeDocuments(before, after)).toEqual([
      { kind: "section-added", page: "template/product", sectionId: "questions", sectionType: "faq" },
    ]);
    expect(compareThemeDocuments(after, before)).toEqual([
      { kind: "section-removed", page: "template/product", sectionId: "questions", sectionType: "faq" },
    ]);
    // The fixed part moving among the sections is a reorder.
    const moved = structuredClone(after);
    moved.pages.templates.product.main = 1;
    expect(compareThemeDocuments(after, moved)).toEqual([{ kind: "sections-reordered", page: "template/product" }]);
    for (const change of compareThemeDocuments(before, after)) expect(themeDocumentChangeSchema.parse(change)).toEqual(change);
  });

  it("names landing pages and theme areas without changing either document", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.pages.landing.eid = { title: "Eid", description: "", sections: [] };
    after.tokens.colors = { ...after.tokens.colors, primary: "#123456" };
    after.tokens.headingCase = after.tokens.headingCase === "uppercase" ? "sentence" : "uppercase";
    after.tokens.radius = after.tokens.radius === "square" ? "rounded" : "square";
    after.blocks.product = { ...after.blocks.product, below: [...after.blocks.product.below].reverse() };
    after.blocks.listing = { ...after.blocks.listing, paging: after.blocks.listing.paging === "numbered" ? "load-more" : "numbered" };
    after.pages.homeMode = { kind: "product", productId: "prod_1" };
    expect(compareThemeDocuments(before, after)).toEqual([
      { kind: "page-added", page: "landing/eid" },
      { kind: "settings-changed", area: "colors" },
      { kind: "settings-changed", area: "typography" },
      { kind: "settings-changed", area: "style" },
      { kind: "settings-changed", area: "listing" },
      { kind: "settings-changed", area: "productPage" },
      { kind: "settings-changed", area: "homeMode" },
    ]);
    expect(before).toEqual(DEFAULT_STOREFRONT_THEME);

    const renamed = structuredClone(after);
    renamed.pages.landing.eid = { title: "Eid offers", description: "", sections: [storefrontSectionDefault("faq", "faq")] };
    expect(compareThemeDocuments(after, renamed)).toEqual([
      { kind: "page-changed", page: "landing/eid" },
      { kind: "section-added", page: "landing/eid", sectionId: "faq", sectionType: "faq" },
    ]);
    expect(compareThemeDocuments(renamed, storefrontTemplateTheme(renamed.template))).toContainEqual({ kind: "page-removed", page: "landing/eid" });
  });
});
