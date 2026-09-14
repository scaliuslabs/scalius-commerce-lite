import { describe, expect, it } from "vitest";

import { validateNavigationSearch } from "./index";

/**
 * The Navigation route carries both views: no `menu` is the menus list, a
 * `menu` is that menu's editor. Other builders deep-link here with `panel` and
 * `q` already set, so the schema has to keep accepting them.
 */
describe("validateNavigationSearch", () => {
  it("defaults to the menus list with no menu selected", () => {
    expect(validateNavigationSearch({})).toEqual({ panel: "items", q: "" });
  });

  it("keeps the panel deep links the header and footer builders use", () => {
    expect(validateNavigationSearch({ panel: "placements", q: "" }))
      .toEqual({ panel: "placements", q: "" });
    expect(validateNavigationSearch({ panel: "history", q: "" }).panel).toBe("history");
    expect(validateNavigationSearch({ panel: "not-a-panel", q: "" }).panel).toBe("items");
  });

  it("treats a cleared menu as a return to the menus list", () => {
    expect(validateNavigationSearch({ menu: "   " }).menu).toBeUndefined();
    expect(validateNavigationSearch({ menu: "menu_header" }).menu).toBe("menu_header");
  });

  it("only carries a parent while a new item is being added", () => {
    expect(validateNavigationSearch({ item: "new", parent: "item_shop" })).toMatchObject({
      item: "new",
      parent: "item_shop",
    });
    expect(validateNavigationSearch({ item: "item_shop", parent: "item_shop" }).parent)
      .toBeUndefined();
  });

  it("caps the search term so a pasted URL cannot grow without bound", () => {
    expect(validateNavigationSearch({ q: "x".repeat(200) }).q).toHaveLength(100);
    expect(validateNavigationSearch({ q: 42 }).q).toBe("");
  });
});
