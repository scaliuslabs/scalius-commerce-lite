import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const storefrontRoot = [cwd(), join(cwd(), "apps/storefront")].find((candidate) =>
  existsSync(join(candidate, "src/pages/cart.astro")),
);

if (!storefrontRoot) {
  throw new Error("Unable to locate storefront package root for SEO regression tests");
}

describe("storefront SEO regressions", () => {
  it("does not publish cart URLs in the static sitemap", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/sitemap-static.xml.ts"), "utf8");

    expect(source).not.toContain("`${baseUrl}/cart`");
  });

  it("marks the cart page noindex", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain("noindex");
  });
});
