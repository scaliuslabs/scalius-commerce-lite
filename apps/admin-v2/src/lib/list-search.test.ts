// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { adoptListSearch, listSearchKey, readListSearch, writeListSearch } from "./list-search";

describe("list search terms", () => {
  it("keeps one term per tab, so a search never follows the merchant into another tab", () => {
    const all = listSearchKey("products", { trashed: false }, "status");
    const drafts = listSearchKey("products", { trashed: false, status: "draft" }, "status");
    const trash = listSearchKey("products", { trashed: true, status: "draft" }, "status");
    expect([all, drafts, trash]).toEqual(["products", "products.draft", "products.trash"]);

    writeListSearch(all, "panjabi");
    expect(readListSearch(drafts)).toBe("");
    expect(readListSearch(trash)).toBe("");
    expect(readListSearch(all)).toBe("panjabi");
    expect(sessionStorage.getItem("admin.listSearch.products")).toBe("panjabi");
  });

  it("lets a ?q= link replace the tab's term once, and keeps the term without one", () => {
    writeListSearch("inventory.alerts", "old");
    expect(adoptListSearch("inventory.alerts", "saree")).toBe("saree");
    expect(adoptListSearch("inventory.alerts", undefined)).toBe("saree");
    expect(readListSearch("inventory.variants")).toBe("");
  });
});
