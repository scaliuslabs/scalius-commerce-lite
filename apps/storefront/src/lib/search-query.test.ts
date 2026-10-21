import { describe, expect, it } from "vitest";
import { searchScopeRedirect } from "./search-query";

const at = (path: string) => searchScopeRedirect(new URL(path, "https://shop.test"));

describe("search within a category", () => {
  it("sends a scoped search to the category's listing with the query", () => {
    expect(at("/search?q=usb%20c%20%20cable&category=phones")).toBe("/categories/phones?q=usb+c+cable");
    expect(at("/search?category=Phones")).toBe("/categories/phones");
  });

  it("drops an empty or unusable scope and keeps the rest", () => {
    expect(at("/search?q=cable&category=")).toBe("/search?q=cable");
    expect(at("/search?q=cable&category=..%2Fadmin&sortBy=price-asc")).toBe("/search?q=cable&sortBy=price-asc");
  });

  it("leaves a search without a scope alone", () => {
    expect(at("/search?q=cable")).toBeNull();
  });
});
