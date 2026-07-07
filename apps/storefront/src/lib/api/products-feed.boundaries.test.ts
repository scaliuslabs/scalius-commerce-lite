import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "../test-source-paths";

const PRODUCTS_API_SOURCE = storefrontSourcePath("lib/api/products.ts");

describe("storefront feed product API boundaries", () => {
  it("requires the dedicated feed projection for public feed XML", () => {
    const source = readFileSync(PRODUCTS_API_SOURCE, "utf8");

    expect(source).toContain("export async function getFeedProducts");
    expect(source).toContain("getApiV1ProductsFeed");
    expect(source).toContain('includeVariants: "true"');
    expect(source).toContain("Dedicated product feed SDK route is missing.");
    expect(source).not.toContain("return getAllProducts(normalizedOptions)");
  });
});
