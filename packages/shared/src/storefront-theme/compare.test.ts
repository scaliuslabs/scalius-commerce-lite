import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { compareThemeDocuments, formatThemeDocumentChanges } from "./compare";

describe("theme changes", () => {
  it("ignores object-key order and reports actual settings, section and ordering edits", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.tokens = Object.fromEntries(Object.entries(after.tokens).reverse()) as typeof after.tokens;
    expect(compareThemeDocuments(before, after)).toEqual([]);
    const [first, second] = after.pages.home;
    if (!first || !second) throw new Error("Need two default sections.");
    after.pages.home = [second, { ...first, hidden: true }, { ...first, id: "campaign" }];
    const changes = compareThemeDocuments(before, after);
    expect(changes).toContainEqual({ kind: "added", page: "home", sectionId: "campaign" });
    expect(changes).toContainEqual({ kind: "removed", page: "home", sectionId: "categories" });
    expect(changes).toContainEqual({ kind: "reordered", page: "home" });
    expect(changes).toContainEqual({ kind: "settings", page: "home", sectionId: first.id });
    expect(formatThemeDocumentChanges(changes)).toContain("home: campaign: section added");
  });

  it("compares landing content and fixed commerce blocks without changing either document", () => {
    const before = structuredClone(DEFAULT_STOREFRONT_THEME);
    const after = structuredClone(before);
    after.pages.landing.eid = { title: "Eid", sections: [], overrideCms: false };
    after.pages.product.blocks.reverse();
    after.pages.collection.blocks[0]!.hidden = true;
    expect(compareThemeDocuments(before, after)).toEqual([
      { kind: "added", page: "landing/eid" },
      { kind: "reordered", page: "product" },
      { kind: "settings", page: "collection", sectionId: "breadcrumbs" },
    ]);
    expect(before).toEqual(DEFAULT_STOREFRONT_THEME);
  });
});
