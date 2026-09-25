// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: `#product-gallery { contain: layout style }` made the gallery
// the containing block and stacking context of its fixed, full-screen zoom
// dialog, so tapping the photo on a phone opened the "full-screen" viewer
// inside the 366x453 photo box, beneath the sticky header.
const gallery = readFileSync(
  fileURLToPath(new URL("./ProductGallery.astro", import.meta.url)),
  "utf8",
);
const layout = readFileSync(
  fileURLToPath(new URL("./ProductPageLayout.astro", import.meta.url)),
  "utf8",
);

const TRAPS_FIXED = /\b(?:contain\s*:[^;"}]*\b(?:layout|paint|strict|content)\b|transform\s*:|filter\s*:|will-change\s*:\s*transform)/;

describe("product gallery zoom dialog", () => {
  it("is a descendant of the gallery root", () => {
    expect(gallery).toMatch(/data-mobile-zoom-modal[\s\S]*class="[^"]*\bfixed inset-0\b/);
  });

  it("has no ancestor rule that traps a fixed descendant", () => {
    const rootRule = gallery.match(/#product-gallery\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootRule).not.toMatch(TRAPS_FIXED);
    const rootTag = gallery.match(/<div\s+id="product-gallery"[\s\S]*?>/)?.[0] ?? "";
    expect(rootTag).not.toMatch(/style=/);
    const layoutRules = layout.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    expect(layoutRules).not.toMatch(TRAPS_FIXED);
  });
});
