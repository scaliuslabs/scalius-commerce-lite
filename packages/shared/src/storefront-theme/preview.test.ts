import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import {
  storefrontPreviewPaintSchema,
  storefrontPreviewRenderSchema,
  storefrontPreviewScopeSchema,
  storefrontScopeRegions,
  storefrontThemeWithScope,
} from "./preview";
import { STOREFRONT_MAX_SECTIONS, storefrontSectionDefault } from "./sections";

const faq = (id: string) => storefrontSectionDefault("faq", id);

describe("preview scopes", () => {
  it("accepts the home, landing and template scopes", () => {
    expect(storefrontPreviewScopeSchema.parse({ kind: "home" })).toEqual({ kind: "home" });
    expect(storefrontPreviewScopeSchema.parse({ kind: "landing", slug: "eid-offers" })).toEqual({ kind: "landing", slug: "eid-offers" });
    for (const template of ["product", "collection", "cart", "page"]) {
      expect(storefrontPreviewScopeSchema.parse({ kind: "template", template, main: 1 })).toEqual({ kind: "template", template, main: 1 });
    }
  });

  it("refuses an unknown template, a bad landing slug, extra keys and a bad fixed part", () => {
    for (const bad of [
      { kind: "template", template: "checkout", main: 0 },
      { kind: "template", template: "product", main: -1 },
      { kind: "template", template: "product", main: STOREFRONT_MAX_SECTIONS + 1 },
      { kind: "landing", slug: "Not A Slug" },
      { kind: "home", slug: "extra" },
      { kind: "blog" },
    ]) {
      expect(storefrontPreviewScopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("preview render and paint bodies", () => {
  it("accepts sections of a scope with the optional market presence", () => {
    const body = { scope: { kind: "template", template: "product", main: 1 }, sections: [faq("a"), faq("b")], presence: "en-in" };
    expect(storefrontPreviewRenderSchema.parse(body)).toMatchObject({ presence: "en-in" });
  });

  it("refuses more sections than a page holds, duplicate ids and a fixed part past the last section", () => {
    const many = Array.from({ length: STOREFRONT_MAX_SECTIONS + 1 }, (_, index) => faq(`faq-${index}`));
    expect(storefrontPreviewRenderSchema.safeParse({ scope: { kind: "home" }, sections: many }).success).toBe(false);
    expect(storefrontPreviewRenderSchema.safeParse({ scope: { kind: "home" }, sections: [faq("a"), faq("a")] }).success).toBe(false);
    const past = storefrontPreviewRenderSchema.safeParse({ scope: { kind: "template", template: "cart", main: 2 }, sections: [faq("a")] });
    expect(past.success).toBe(false);
    if (!past.success) expect(past.error.issues[0]).toMatchObject({ path: ["scope", "main"] });
    expect(storefrontPreviewRenderSchema.safeParse({ scope: { kind: "home" }, sections: [], presence: "NOT/valid" }).success).toBe(false);
  });

  it("paints a whole document and refuses extra keys", () => {
    expect(storefrontPreviewPaintSchema.parse({ theme: DEFAULT_STOREFRONT_THEME }).theme.version).toBe(DEFAULT_STOREFRONT_THEME.version);
    expect(storefrontPreviewPaintSchema.safeParse({ theme: DEFAULT_STOREFRONT_THEME, extra: 1 }).success).toBe(false);
    expect(storefrontPreviewPaintSchema.safeParse({ theme: { ...DEFAULT_STOREFRONT_THEME, version: 7 } }).success).toBe(false);
  });
});

describe("a scope in a document", () => {
  it("replaces one page's sections and leaves the rest as saved", () => {
    const sections = [faq("one"), faq("two"), faq("three")];
    const home = storefrontThemeWithScope(DEFAULT_STOREFRONT_THEME, { kind: "home" }, sections);
    expect(home.pages.home).toEqual(sections);
    expect(home.pages.templates).toEqual(DEFAULT_STOREFRONT_THEME.pages.templates);

    const landing = storefrontThemeWithScope(DEFAULT_STOREFRONT_THEME, { kind: "landing", slug: "eid" }, sections);
    expect(landing.pages.landing.eid).toEqual({ title: "eid", description: "", sections });
    expect(DEFAULT_STOREFRONT_THEME.pages.landing.eid).toBeUndefined();

    const product = storefrontThemeWithScope(DEFAULT_STOREFRONT_THEME, { kind: "template", template: "product", main: 1 }, sections);
    expect(product.pages.templates.product).toEqual({ sections, main: 1 });
    expect(product.pages.templates.cart).toEqual(DEFAULT_STOREFRONT_THEME.pages.templates.cart);
    expect(product.pages.home).toEqual(DEFAULT_STOREFRONT_THEME.pages.home);
  });

  it("lists a template as a before and an after region split at the fixed part", () => {
    const sections = [faq("one"), faq("two"), faq("three")];
    const theme = storefrontThemeWithScope(DEFAULT_STOREFRONT_THEME, { kind: "template", template: "page", main: 1 }, sections);
    expect(storefrontScopeRegions(theme.pages, { kind: "template", template: "page", main: 1 })).toEqual([
      { region: "before", sections: [sections[0]] },
      { region: "after", sections: [sections[1], sections[2]] },
    ]);
    expect(storefrontScopeRegions(theme.pages, { kind: "home" })).toEqual([{ region: "page", sections: theme.pages.home }]);
    expect(storefrontScopeRegions(theme.pages, { kind: "landing", slug: "missing" })).toEqual([{ region: "page", sections: [] }]);
  });
});
