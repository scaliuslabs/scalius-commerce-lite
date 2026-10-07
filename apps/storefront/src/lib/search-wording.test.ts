import { describe, expect, it } from "vitest";
import { searchWording } from "./search-wording";

const base = { resultCountLabel: "3 results", productCount: 3, page: 1 };

describe("searchWording", () => {
  it("collapses whitespace in the query and uses typographic quotes", () => {
    const wording = searchWording({ ...base, query: "  QA   shoes " });
    expect(wording.title).toBe("Search results for “QA shoes”");
    expect(wording.title).not.toMatch(/\s{2}/);
    expect(wording.description).toBe("3 results for “QA shoes”.");
    expect(wording.countLabel).toBe("3 results for “QA shoes”");
    expect(wording.correction).toBeNull();
  });

  it("leads with the corrected query and names the typed one second", () => {
    const wording = searchWording({ ...base, resultCountLabel: "1 result", productCount: 1, query: "test", correctedQuery: "nest" });
    expect(wording.correction).toEqual({ shownQuery: "nest", originalQuery: "test" });
    expect(wording.title).toBe("Search results for “nest”");
    expect(wording.description).toBe("1 result for “nest”. No exact results for “test”.");
    expect(wording.countLabel).toBe("1 result for “nest”");
  });

  it("ignores a correction equal to the query or without results", () => {
    expect(searchWording({ ...base, query: "Nest", correctedQuery: "nest" }).correction).toBeNull();
    const none = searchWording({ ...base, productCount: 0, resultCountLabel: "0 results", query: "test", correctedQuery: "nest" });
    expect(none.correction).toBeNull();
    expect(none.countLabel).toBeNull();
    expect(none.title).toBe("Search results for “test”");
  });

  it("names the plain listing and later pages", () => {
    expect(searchWording({ ...base, query: "", page: 2 }).title).toBe("All products – Page 2");
    expect(searchWording({ ...base, query: "" }).description).toBe("Explore our full collection of products.");
  });
});
