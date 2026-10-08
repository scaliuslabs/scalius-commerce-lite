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

  it("puts the details in a sticky 345px (stacked) or 400–480px (grid) column", () => {
    expect(layout).toMatch(/grid-template-columns: minmax\(0, 1fr\) var\(--product-info-column\);/);
    expect(layout).toMatch(/\[data-gallery="stacked"\] \{\s*--product-info-column: 345px;/);
    expect(layout).toMatch(/\[data-gallery="grid"\] \{\s*--product-info-column: 400px;/);
    expect(layout).toMatch(/@media \(min-width: 80rem\) \{\s*\.product-layout\[data-gallery="grid"\] \{\s*--product-info-column: 480px;/);
    expect(layout).toMatch(/\[data-gallery="grid"\] > :global\(\[data-product-summary\]\) \{[^}]*position: sticky;/);
  });

  it("starts the sticky details column at the top of its row, so the grid never stretches it to the photos' height", () => {
    expect(layout).toMatch(/\[data-gallery="grid"\] > :global\(\[data-product-summary\]\) \{\s*(?:\/\*[^*]*\*\/\s*)?align-self: start;\s*position: sticky;/);
  });

  it("sticks the marketplace gallery within the product grid without changing classic beside pages", () => {
    expect(layout).toMatch(/\[data-gallery="beside"\]\[data-facts-column\] > :global\(\[data-product-gallery\]\) \{\s*position: sticky;/);
    expect(layout).toMatch(/\[data-gallery="beside"\]\[data-facts-column\] > :global\(\[data-product-gallery\] \.gallery-layout\) \{\s*position: static;/);
  });

  it("lists every photo on computers, two across on the grid", () => {
    expect(gallery).toContain('<ul class="gallery-list hidden gap-2 lg:grid"');
    expect(gallery).toMatch(/\[data-gallery="grid"\](?::not\(\.\\#\))? \.gallery-list(?::not\(\.\\#\))? \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });

  it("centres only the resolved 3:4 portrait stage at Aarong's desktop width", () => {
    // The CSS cap is the number the main photo's `sizes` name
    // (productGalleryPortraitMaxPx), set on the gallery as a custom property.
    expect(gallery).toContain("const portraitMaxPx = productGalleryPortraitMaxPx(layout);");
    expect(gallery).toContain('data-portrait-stage={portraitMaxPx === null ? undefined : ""}');
    expect(gallery).toContain("style={portraitMaxPx === null ? undefined : `--gallery-portrait-max: ${portraitMaxPx}px;`}");
    expect(gallery).toMatch(/@media \(min-width: 64rem\) \{\s*#product-gallery\[data-portrait-stage\](?::not\(\.\\#\))? \{\s*max-width: var\(--gallery-portrait-max\);\s*justify-self: center;/);
    expect(gallery).not.toMatch(/\b404px\b/);
  });
});
