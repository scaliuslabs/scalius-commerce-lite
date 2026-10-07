import { describe, expect, it } from "vitest";
import { localizedPaths } from "./localized-paths";

const productPath = (handle: string) => `/products/${handle}`;

describe("localizedPaths", () => {
  it("is null for a page without localized handles, so a single-language store keeps its alternates", () => {
    expect(localizedPaths(null, productPath)).toBeNull();
    expect(localizedPaths({ sourceSlug: "tee" }, productPath)).toBeNull();
    expect(localizedPaths({ sourceSlug: "tee", localizedSlugs: {} }, productPath)).toBeNull();
  });

  it("names the page's path in each language with a handle and the source path for the rest", () => {
    expect(localizedPaths({ sourceSlug: "tee", localizedSlugs: { bn: "ti-shirt" } }, productPath)).toEqual({
      source: "/products/tee",
      byLocale: { bn: "/products/ti-shirt" },
    });
  });

  it("gives way to the merchant's canonical path override, one URL for every language", () => {
    expect(localizedPaths({ sourceSlug: "tee", localizedSlugs: { bn: "ti-shirt" }, canonicalPath: "/products/shirt" }, productPath)).toBeNull();
  });
});
