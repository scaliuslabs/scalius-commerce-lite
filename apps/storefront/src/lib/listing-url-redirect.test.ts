// @vitest-environment node

import { describe, expect, it } from "vitest";
import { catalogRedirectBeforeReads } from "./listing-url-redirect";
import { resolveProductListQueryState } from "./product-list-query";

const at = (path: string) => new URL(path, "https://shop.example.test");

function answer(routePattern: string, path: string): { status: number; location: string | null } | null {
  const response = catalogRedirectBeforeReads(routePattern, at(path));
  return response ? { status: response.status, location: response.headers.get("Location") } : null;
}

describe("catalog redirects decided before any read", () => {
  it("redirects listing URLs that are not in their clean form, as the page would", () => {
    for (const route of ["/categories/[slug]", "/brands/[slug]", "/collections/[id]"]) {
      const base = route.replace("[slug]", "bags").replace("[id]", "col_1");
      for (const query of ["?minPrice=&maxPrice=", "?page=0", "?sortBy=nope", "?inStock=yes", "?Foo=1", "?q=", "?page=2&page=3", "?minRating=9"]) {
        const expected = resolveProductListQueryState({ url: at(`${base}${query}`), allowUnknownAttributes: true }).redirectPath;
        expect(expected, `${base}${query}`).not.toBeNull();
        expect(answer(route, `${base}${query}`)).toEqual({ status: 302, location: expected });
      }
    }
  });

  it("leaves clean and facet-shaped URLs to the page (facet values need the listing's facets)", () => {
    expect(answer("/categories/[slug]", "/categories/bags")).toBeNull();
    expect(answer("/categories/[slug]", "/categories/bags?page=2&sortBy=price-asc")).toBeNull();
    expect(answer("/categories/[slug]", "/categories/bags?color=red&option.size=m")).toBeNull();
    expect(answer("/collections/[id]", "/collections/col_1?inStock=true")).toBeNull();
    expect(answer("/search", "/search?q=linen")).toBeNull();
  });

  it("redirects mis-cased handles permanently, query kept", () => {
    expect(answer("/categories/[slug]", "/categories/Bags?page=2")).toEqual({ status: 301, location: "/categories/bags?page=2" });
    expect(answer("/brands/[slug]", "/brands/Acme")).toEqual({ status: 301, location: "/brands/acme" });
    expect(answer("/products/[slug]", "/products/Aster-Clogs?variant=SKU_A")).toEqual({ status: 301, location: "/products/aster-clogs?variant=SKU_A" });
    expect(answer("/products/[slug]", "/products/aster-clogs?variant=SKU_A")).toBeNull();
  });

  it("sends a scoped search to its category and rejects an unclean search query", () => {
    expect(answer("/search", "/search?category=Bags&q=  linen  ")).toEqual({ status: 302, location: "/categories/bags?q=linen" });
    const expected = resolveProductListQueryState({ url: at("/search?q=linen&sortBy=nope"), allowUnknownAttributes: true, rankByRelevance: true }).redirectPath;
    expect(answer("/search", "/search?q=linen&sortBy=nope")).toEqual({ status: 302, location: expected });
  });

  it("decides nothing for other routes", () => {
    expect(answer("/", "/?page=0")).toBeNull();
    expect(answer("/[slug]", "/About?x=")).toBeNull();
  });
});
