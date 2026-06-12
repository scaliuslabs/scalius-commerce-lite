import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const storefrontRoot = fileURLToPath(new URL("../..", import.meta.url));

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
