// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression (boutique, stacked product page): the breadcrumb started at the
// container edge, the photo in a 36rem centred column and the details in a
// 48rem one, so the three left edges sat at 112, 432 and 336 px at 1440 px.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("stacked product page", () => {
  const layout = read("./ProductPageLayout.astro");

  it("puts the photos and the details in one centred column", () => {
    expect(layout).toMatch(
      /\.product-layout\[data-gallery="stacked"\] > :global\(\*\) \{\s*grid-column: 1 \/ -1;\s*width: 100%;\s*max-width: var\(--product-stacked-column\);\s*margin-inline: auto;/,
    );
    expect(layout).not.toMatch(/#product-gallery\) \{\s*max-width/);
    expect(layout).toContain("--product-stacked-column: max(24rem, min(36rem, calc(100svh - 20rem)));");
  });

  it("starts the breadcrumb at the same edge", () => {
    expect(layout).toMatch(/:global\(\[data-product-stacked-crumbs\] ol\) \{\s*max-width: var\(--product-stacked-column\);\s*margin-inline: auto;/);
    expect(read("../../pages/products/[slug].astro")).toContain(
      'data-product-stacked-crumbs={productPageLayout.gallery === "stacked" ? "" : undefined}',
    );
  });
});
