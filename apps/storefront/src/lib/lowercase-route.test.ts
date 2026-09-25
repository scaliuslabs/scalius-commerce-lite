// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lowercaseHandleRedirect } from "./lowercase-route";

// Regression: /products/BB-CATALOG-PANJABI answered 404 although handles are
// lowercase-only, so a mis-cased link could only mean the lowercase product.
describe("mis-cased catalog handles", () => {
  it("redirect permanently to the lowercase path and keep the query as it is", () => {
    const response = lowercaseHandleRedirect(new URL("https://shop.test/products/Aster-Clogs?variant=var_AbC"));
    expect(response?.status).toBe(301);
    expect(response?.headers.get("Location")).toBe("/products/aster-clogs?variant=var_AbC");
  });

  it("leaves a lowercase path alone", () => {
    expect(lowercaseHandleRedirect(new URL("https://shop.test/products/aster-clogs?variant=var_AbC"))).toBeNull();
  });

  it.each(["products", "categories", "brands"])("the %s page checks before reading the catalog", (route) => {
    const page = readFileSync(fileURLToPath(new URL(`../pages/${route}/[slug].astro`, import.meta.url)), "utf8");
    expect(page).toMatch(
      /const \{ slug \} = Astro\.params;\n\/\/ Handles are lowercase[^\n]*\nconst lowercaseRedirect = lowercaseHandleRedirect\(Astro\.url\);\nif \(lowercaseRedirect\) return lowercaseRedirect;/,
    );
  });
});
