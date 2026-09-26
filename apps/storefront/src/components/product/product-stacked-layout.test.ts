// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stacked (Dawn) and grid (Target) product pages: every photo in the wide
// column and the details in a sticky column beside it, so the buy box starts
// at the top of the first screen (it sat at y=1002 under one centred photo).
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("stacked and grid product pages", () => {
  const layout = read("./ProductPageLayout.astro");
  const gallery = read("./ProductGallery.astro");

  it("puts the details in a sticky 345px (stacked) or 400px (grid) column", () => {
    expect(layout).toMatch(/grid-template-columns: minmax\(0, 1fr\) var\(--product-info-column\);/);
    expect(layout).toMatch(/\[data-gallery="stacked"\] \{\s*--product-info-column: 345px;/);
    expect(layout).toMatch(/\[data-gallery="grid"\] \{\s*--product-info-column: 400px;/);
    expect(layout).toMatch(/:nth-child\(2\)\) \{\s*position: sticky;/);
  });

  it("lists every photo on computers, two across on the grid", () => {
    expect(gallery).toContain('<ul class="gallery-list hidden gap-2 lg:grid"');
    expect(gallery).toMatch(/\[data-gallery="grid"\] \.gallery-list \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });
});
