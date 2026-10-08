import { describe, expect, it } from "vitest";
import v9 from "./fixtures/v9.json";
import {
  parseStoredStorefrontThemeDocument,
  resolveStorefrontTheme,
  storefrontThemeDocumentSchema,
  EMPTY_STORE_SHAPE,
  STOREFRONT_HEADER_VARIANTS,
} from "../storefront-theme";

const stored = (blocks: Record<string, unknown>) => {
  const doc = JSON.parse(JSON.stringify(v9)) as { blocks: Record<string, unknown> };
  doc.blocks = { ...doc.blocks, ...blocks };
  return JSON.stringify(doc);
};
const read = (blocks: Record<string, unknown>) => parseStoredStorefrontThemeDocument(stored(blocks));

describe("the three header layouts", () => {
  it("has exactly inline-nav, search-first and centered-logo", () => {
    expect(Object.keys(STOREFRONT_HEADER_VARIANTS)).toEqual(["inline-nav", "search-first", "centered-logo"]);
  });

  // Every header a stored document can still name, and the layout and settings it reads as.
  const MAPPING: Array<[string, string, Record<string, unknown>]> = [
    ["boutique-inline", "inline-nav", { search: "icon", rowTone: "page", cartTotal: false }],
    ["showcase-simple", "inline-nav", { search: "icon", rowTone: "page", cartTotal: false }],
    ["fashion-department", "inline-nav", { search: "field", rowTone: "page", cartTotal: false }],
    ["heritage-nav", "centered-logo", { search: "field", rowTone: "page", cartTotal: false }],
    ["spec-two-row", "search-first", { search: "field", rowTone: "header", cartTotal: false }],
    ["tech-rounded", "search-first", { search: "field", rowTone: "header", cartTotal: false }],
    ["marketplace-search", "search-first", { search: "scoped", rowTone: "header", cartTotal: false }],
    ["marketplace-light", "search-first", { search: "scoped", rowTone: "page", cartTotal: false }],
    ["mall-departments", "search-first", { search: "scoped", rowTone: "page", cartTotal: true }],
    ["mall-search", "search-first", { search: "scoped", rowTone: "page", cartTotal: true }],
    ["retail-pill", "search-first", { search: "field", rowTone: "header", cartTotal: false }],
    ["grocery-shell", "search-first", { search: "field", rowTone: "page", cartTotal: true }],
  ];

  it.each(MAPPING)("reads a stored %s header as %s", (old, layout, settings) => {
    const doc = read({ header: { variant: old, settings: {} } });
    expect(doc).not.toBeNull();
    expect(doc!.blocks.header).toEqual({ variant: layout, settings });
    expect(storefrontThemeDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("keeps a stored cart total on", () => {
    const doc = read({ header: { variant: "retail-pill", settings: { cartTotal: true } } });
    expect(doc!.blocks.header.settings).toMatchObject({ cartTotal: true });
    expect(read({ header: { variant: "mall-search", settings: { cartTotal: false } } })!.blocks.header.settings).toMatchObject({ cartTotal: false });
  });

  it("reads the departments list that opened on the home page as one that opens on demand", () => {
    const doc = read({ desktopNav: { variant: "departments-rail", settings: { open: "home" } } });
    expect(doc!.blocks.desktopNav).toEqual({ variant: "departments-rail", settings: { open: "demand" } });
    expect(read({ desktopNav: { variant: "departments-rail", settings: { open: "always" } } })!.blocks.desktopNav.settings).toEqual({ open: "always" });
  });

  it("drops the phone drawer's row height and turns the app banner into the announcement", () => {
    const mobile = read({ mobileNav: { variant: "drill-in-drawer", settings: { rows: "tall" } } });
    expect(mobile!.blocks.mobileNav).toEqual({ variant: "drill-in-drawer", settings: {} });
    const banner = read({ topBar: { variant: "app-banner", settings: { text: "Free delivery", link: null } } });
    expect(banner!.blocks.topBar).toEqual({ variant: "announcement", settings: { text: "Free delivery", link: null } });
  });

  it.each([
    ["minimal-columns", "columns", "page"],
    ["product-widgets", "columns", "page"],
    ["support-dark", "columns", "header"],
    ["brand-black", "columns", "ink"],
    ["newsletter-grey", "centered-compact", "muted"],
  ])("reads a stored %s footer as %s with the %s tone, keeping its words", (old, layout, tone) => {
    const words = { tagline: "Since 1998", about: "Family shop.", copyright: "Acme Ltd." };
    const doc = read({ footer: { variant: old, settings: words } });
    expect(doc!.blocks.footer).toEqual({ variant: layout, settings: { ...words, tone } });
    expect(storefrontThemeDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("drops the bottom bar's Cart and Search tabs: the header always has them", () => {
    const tabs = (stored: string[]) => {
      const doc = read({ mobileNav: { variant: "bottom-tabs", settings: { tabs: stored, drawer: "accordion" } } });
      expect(storefrontThemeDocumentSchema.safeParse(doc).success).toBe(true);
      return (doc!.blocks.mobileNav.settings as { tabs: string[] }).tabs;
    };
    expect(tabs(["home", "categories", "search", "cart", "account"])).toEqual(["home", "categories", "account"]);
    expect(tabs(["home", "categories", "offers", "compare", "cart"])).toEqual(["home", "categories", "offers", "compare"]);
    // A bar left with fewer than three tabs takes Offers, then Categories, then Home; never Compare.
    expect(tabs(["home", "search", "cart", "account"])).toEqual(["home", "account", "offers"]);
    expect(tabs(["search", "cart", "account"])).toEqual(["account", "offers", "categories"]);
  });

  it("keeps a directory footer as it is", () => {
    const settings = { style: "bands", tagline: "", about: "", copyright: "" };
    expect(read({ footer: { variant: "directory", settings } })!.blocks.footer).toEqual({ variant: "directory", settings });
  });

  it("resolves every layout and setting combination, with each desktop menu, on an empty store", () => {
    const base = read({})!;
    for (const variant of Object.keys(STOREFRONT_HEADER_VARIANTS)) {
      const theme = structuredClone(base);
      theme.blocks.header = { variant, settings: { ...STOREFRONT_HEADER_VARIANTS[variant as keyof typeof STOREFRONT_HEADER_VARIANTS].defaults } } as never;
      const resolved = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE);
      expect(resolved.blocks.header.variant).toBe(variant);
    }
  });
});
