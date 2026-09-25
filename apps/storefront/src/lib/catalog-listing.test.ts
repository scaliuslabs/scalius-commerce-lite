import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
  STOREFRONT_TEMPLATE_IDS,
} from "@scalius/shared/storefront-theme";
import {
  CATALOG_FACET_SEARCH_MIN_VALUES,
  catalogAspectChips,
  catalogChildLinks,
  catalogFacetAnchor,
  catalogFacetDisplay,
  catalogListingControls,
  catalogListingPresentation,
  catalogPopularFilters,
  catalogQuickFilters,
  catalogShelves,
  quickGridSpec,
} from "./catalog-listing";
import { productGridColumnCount } from "./product-card-layout";

describe("listing presentation", () => {
  it("maps each layout to where the facets live and how results lay out", () => {
    const presentation = (id: (typeof STOREFRONT_TEMPLATE_IDS)[number]) => {
      const { filters, results, shelves, layout } = catalogListingPresentation(
        resolveStorefrontTheme(storefrontTemplateTheme(id), { ...EMPTY_STORE_SHAPE, hasCollections: true }).blocks.listing,
      );
      return { layout, filters, results, shelves };
    };
    expect(presentation("department-mall")).toEqual({ layout: "sidebar-grid", filters: "sidebar", results: "grid", shelves: false });
    expect(presentation("boutique")).toEqual({ layout: "bar-drawer", filters: "drawer", results: "grid", shelves: false });
    expect(presentation("heritage-editorial")).toEqual({ layout: "shelves", filters: "drawer", results: "grid", shelves: true });
    expect(presentation("daily-essentials")).toEqual({ layout: "quick-grid", filters: "drawer", results: "quick", shelves: false });
    const list = catalogListingPresentation({
      ...resolveStorefrontTheme(DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE).blocks.listing,
      layout: { variant: "list", settings: {}, requested: "list" },
    });
    expect(list).toMatchObject({ filters: "sidebar", results: "list" });
  });

  it("shows filters only when there is something to narrow", () => {
    const facets = { refinementCount: 0, facetCount: 2, showsPrice: true };
    expect(catalogListingControls({ ...facets, total: 0 })).toEqual({ sort: false, filters: false });
    expect(catalogListingControls({ ...facets, total: 2 })).toEqual({ sort: true, filters: false });
    expect(catalogListingControls({ ...facets, total: 3 })).toEqual({ sort: true, filters: false });
    expect(catalogListingControls({ ...facets, total: 4 })).toEqual({ sort: true, filters: true });
    expect(catalogListingControls({ total: 40, refinementCount: 0, facetCount: 0, showsPrice: false }))
      .toEqual({ sort: true, filters: false });
    // A refinement keeps both, so the buyer can undo it (even with no results).
    expect(catalogListingControls({ total: 0, refinementCount: 1, facetCount: 0, showsPrice: false }))
      .toEqual({ sort: true, filters: true });
  });
});

describe("facet display types", () => {
  // Option axes and the brand: the API sends "checkbox" and the values decide.
  const option = (...labels: string[]) => ({
    kind: "option" as const,
    display: "checkbox" as const,
    values: labels.map((label) => ({ value: label.toLowerCase(), label, swatch: null as string | null })),
  });

  it("paints an option axis as swatches only when every value is a known colour", () => {
    const swatch = catalogFacetDisplay(option("Black", "navy", "Off-White", "Sky_Blue", "Multicolour"));
    expect(swatch.display).toBe("swatch");
    // Keyed by the submitted value, read from the label.
    expect(swatch.swatches.get("off-white")).toBe("#f4f1e8");
    expect(catalogFacetDisplay(option("Black", "Rose Gold"))).toEqual({ display: "checkbox", swatches: new Map() });
    expect(catalogFacetDisplay(option("কালো", "লাল")).display).toBe("checkbox");
    expect(catalogFacetDisplay(option()).display).toBe("checkbox");
  });

  it("gives long option or brand lists a search field", () => {
    const many = option(...Array.from({ length: CATALOG_FACET_SEARCH_MIN_VALUES + 1 }, (_, index) => `Brand ${index}`));
    expect(catalogFacetDisplay(many).display).toBe("search-list");
    expect(catalogFacetDisplay({ ...many, kind: "brand" }).display).toBe("search-list");
    expect(catalogFacetDisplay({ ...many, values: many.values.slice(0, CATALOG_FACET_SEARCH_MIN_VALUES) }).display).toBe("checkbox");
  });

  it("follows the merchant's display for a typed attribute", () => {
    const attribute = (display: "checkbox" | "range" | "swatch" | "search_list", values = option("Black", "Rose Gold").values) =>
      catalogFacetDisplay({ kind: "attribute", display, values });
    const many = option(...Array.from({ length: CATALOG_FACET_SEARCH_MIN_VALUES + 1 }, (_, index) => `Brand ${index}`)).values;
    expect(attribute("checkbox", many).display).toBe("checkbox");
    expect(attribute("search_list", option("A", "B").values).display).toBe("search-list");
    expect(attribute("range", []).display).toBe("range");
    // A swatch paints from the merchant's colour, then the colour words; a
    // value with neither stays a swatch without paint.
    const swatch = attribute("swatch", [
      { value: "rose gold", label: "Rose Gold", swatch: "#b76e79" },
      { value: "black", label: "Black", swatch: null },
      { value: "sunset", label: "Sunset", swatch: null },
      { value: "bad", label: "Bad", swatch: "red;position:fixed" },
    ]);
    expect(swatch.display).toBe("swatch");
    expect([...swatch.swatches]).toEqual([["rose gold", "#b76e79"], ["black", "#111111"]]);
    // A colour-word option axis stays a checkbox list once typed as one.
    expect(attribute("checkbox", option("Black", "Navy").values).display).toBe("checkbox");
  });
});

describe("toolbar chips", () => {
  const value = (label: string, count: number) => ({ value: label.toLowerCase(), label, count, swatch: null });
  const facets = [
    { id: "a", name: "Size", slug: "size", kind: "attribute" as const, display: "checkbox" as const, unit: null, range: null, values: [value("M", 30), value("L", 50), value("XL", 0)] },
    { id: "option.color", name: "Colour", slug: "option.color", kind: "option" as const, display: "checkbox" as const, unit: null, range: null, values: [value("Red", 12), value("Blue", 40)] },
    { id: "b", name: "Display size", slug: "display-size", kind: "attribute" as const, display: "range" as const, unit: "in", range: { min: 11, max: 17 }, values: [] },
  ];

  it("gives each shown facet an aspect chip with a stable anchor, then Price", () => {
    const chips = catalogAspectChips(facets.map((facet) => ({ ...facet, selectedCount: facet.slug === "size" ? 1 : 0 })), { shown: true, applied: false });
    expect(chips).toEqual([
      { slug: "size", label: "Size", selectedCount: 1, anchor: "catalog-facet-size" },
      { slug: "option.color", label: "Colour", selectedCount: 0, anchor: "catalog-facet-option_2ecolor" },
      { slug: "display-size", label: "Display size", selectedCount: 0, anchor: "catalog-facet-display-size" },
      { slug: "price", label: "Price", selectedCount: 0, anchor: "catalog-facet-price" },
    ]);
    expect(catalogFacetAnchor("option.স্টোরেজ")).toBe("catalog-facet-option_2eস্টোরেজ");
    expect(catalogFacetAnchor("option.size")).not.toBe(catalogFacetAnchor("option-size"));
    // No facet worth a chip: no chips at all, not a lone Price chip.
    expect(catalogAspectChips([], { shown: true, applied: true })).toEqual([]);
  });

  it("links the popular values that narrow the listing, by label", () => {
    const links = catalogPopularFilters({
      facets,
      currentFilters: { size: "m" },
      pathname: "/categories/shirts",
      defaultSort: "newest",
      total: 50,
      max: 3,
    });
    // L matches every product (no narrowing), M is applied, XL matches none,
    // and a range has no value to link.
    expect(links).toEqual([
      { label: "Blue", href: "/categories/shirts?option.color=blue&size=m", active: false },
      { label: "Red", href: "/categories/shirts?option.color=red&size=m", active: false },
    ]);
  });

  it("toggles the shopping switches from page one", () => {
    expect(catalogQuickFilters({ currentFilters: { hasDiscount: "true", page: "3" }, pathname: "/search", defaultSort: "newest" }))
      .toEqual([
        { label: "On sale", active: true, href: "/search" },
        { label: "Free delivery", active: false, href: "/search?freeDelivery=true&hasDiscount=true" },
      ]);
  });
});

describe("shelves and sub-listings", () => {
  const groups = [
    { id: "cotton", label: "Cotton", href: "/categories/cotton" },
    { id: "silk", label: "Silk", href: "/categories/silk" },
    { id: "linen", label: "Linen", href: "/categories/linen" },
  ];
  const item = (id: string, categoryId: string | null) => ({ id, categoryId });

  it("groups the page's products by sub-listing, keeping every product", () => {
    const items = [item("1", "silk"), item("2", "cotton"), item("3", null), item("4", "silk"), item("5", "other"), item("6", "cotton")];
    const shelves = catalogShelves({ groups, items, maxShelves: 8, restTitle: "More" });
    expect(shelves.map((shelf) => [shelf.title, shelf.href, shelf.items.map(({ id }) => id)])).toEqual([
      ["Cotton", "/categories/cotton", ["2", "6"]],
      ["Silk", "/categories/silk", ["1", "4"]],
      ["More", null, ["3", "5"]],
    ]);
    // A lone product joins the last shelf instead of a one-card shelf.
    const lone = catalogShelves({ groups, items: [...items, item("7", "linen")], maxShelves: 8, restTitle: "More" });
    expect(lone.map(({ title, items: shelfItems }) => [title, shelfItems.length])).toEqual([["Cotton", 2], ["Silk", 2], ["More", 3]]);
  });

  it("caps shelves without dropping products, and needs at least two shelves", () => {
    const items = Array.from({ length: 30 }, (_, index) => item(String(index), groups[index % 3]!.id));
    const capped = catalogShelves({ groups, items, maxShelves: 2, restTitle: "More" });
    expect(capped.map(({ title }) => title)).toEqual(["Cotton", "More"]);
    // The next page starts after this one, so every product stays on a shelf.
    expect(capped.reduce((sum, shelf) => sum + shelf.items.length, 0)).toBe(30);
    expect(catalogShelves({ groups, items: [item("1", "silk"), item("2", "silk")], maxShelves: 8, restTitle: "More" })).toEqual([]);
    expect(catalogShelves({ groups: [], items, maxShelves: 8, restTitle: "More" })).toEqual([]);
  });

  it("reads sub-categories from a category once the tree provides them", () => {
    expect(catalogChildLinks({ id: "c", name: "Sarees" })).toEqual([]);
    expect(catalogChildLinks({ children: [{ id: "c1", name: "Silk", slug: "silk sarees" }, { id: 2 }, null] }))
      .toEqual([{ id: "c1", label: "Silk", href: "/categories/silk%20sarees" }]);
  });
});

describe("quick grid", () => {
  it("packs three columns on a phone and six on a laptop listing", () => {
    const grid = quickGridSpec(resolveStorefrontTheme(DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE).layout.grid);
    // 390px phone: 358px of grid; 1280px page: 1216px of grid.
    expect(productGridColumnCount(grid, 358)).toBe(3);
    expect(productGridColumnCount(grid, 1216)).toBe(6);
    expect(productGridColumnCount(grid, 288)).toBe(2);
  });
});
