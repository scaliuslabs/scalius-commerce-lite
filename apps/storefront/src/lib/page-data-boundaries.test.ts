import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STOREFRONT_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("storefront page data boundaries", () => {
  it("keeps category cold-cache reads in the first fetch wave", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/pages/categories/[slug].astro`,
      "utf8",
    );

    const optionsIndex = source.indexOf("const productListOptions");
    const layoutPromiseIndex = source.indexOf("const layoutPromise = getLayoutData()");
    const productsPromiseIndex = source.indexOf(
      "const productsPromise = getProductsByCategory(slug, productListOptions)",
    );
    const attributesPromiseIndex = source.indexOf(
      "const attributesPromise = getFilterableAttributes({ categorySlug: slug })",
    );
    const widgetsPromiseIndex = source.indexOf(
      "const widgetsPromise = categoryPromise.then",
    );
    const promiseAllIndex = source.indexOf("] = await Promise.all([");

    expect(optionsIndex).toBeGreaterThan(-1);
    expect(layoutPromiseIndex).toBeGreaterThan(optionsIndex);
    expect(productsPromiseIndex).toBeGreaterThan(layoutPromiseIndex);
    expect(attributesPromiseIndex).toBeGreaterThan(productsPromiseIndex);
    expect(widgetsPromiseIndex).toBeGreaterThan(attributesPromiseIndex);
    expect(promiseAllIndex).toBeGreaterThan(widgetsPromiseIndex);
    expect(source.slice(promiseAllIndex)).toContain("productsPromise");
    expect(source.slice(promiseAllIndex)).toContain("attributesPromise");
    expect(source.slice(promiseAllIndex)).toContain("widgetsPromise");
  });
});
