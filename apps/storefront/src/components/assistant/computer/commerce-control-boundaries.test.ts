// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd().endsWith("/apps/storefront")
  ? process.cwd().replace(/\/apps\/storefront$/u, "")
  : process.cwd();
const sourceRoot = join(workspaceRoot, "apps/storefront/src");

function source(path: string): string {
  return readFileSync(join(sourceRoot, path), "utf8");
}

describe("Storefront generic-computer commerce boundaries", () => {
  it("allows only exact Add to Cart while keeping buy, cart, and checkout human-only", () => {
    expect(source("components/header/HeaderLayout.astro")).toMatch(
      /id="cart-button"[\s\S]{0,180}data-scalius-computer-human-only/u,
    );
    expect(source("components/CartFlyout.tsx")).toMatch(
      /<SheetContent[\s\S]{0,180}data-scalius-computer-human-only/u,
    );
    expect(
      source("components/product/ProductSummary.astro").match(
        /data-scalius-computer-human-only/gu,
      ),
    ).toHaveLength(1);
    expect(source("components/product/ProductSummary.astro")).toContain(
      "data-scalius-computer-action={initialAddToCartAvailable",
    );
    expect(source("components/product/ProductSummary.astro")).toContain(
      "buildStorefrontComputerAddToCartLabel({",
    );
    expect(
      source("components/ProductShortcode.tsx").match(
        /data-scalius-computer-human-only/gu,
      ),
    ).toHaveLength(1);
    expect(source("components/ProductShortcode.tsx")).toContain(
      'canAddToCart ? "allow" : undefined',
    );
    expect(source("pages/cart.astro")).toContain(
      "data-scalius-computer-human-only",
    );
    expect(source("pages/checkout.astro")).toContain(
      "data-scalius-computer-human-only",
    );
    expect(source("pages/buy/[slug].ts")).toContain(
      "<body data-scalius-computer-human-only>",
    );
  });
});
