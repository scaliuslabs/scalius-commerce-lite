import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cmsPageSource = readFileSync(
  new URL("../pages/[slug].astro", import.meta.url),
  "utf8",
);
const productShortcodeSource = readFileSync(
  new URL("../components/ProductShortcode.tsx", import.meta.url),
  "utf8",
);

describe("CMS storefront theme boundaries", () => {
  it("uses storefront semantic colors instead of fixed light-mode grays", () => {
    expect(cmsPageSource).not.toMatch(/(?:bg|border|text)-gray-/);
    expect(productShortcodeSource).not.toMatch(/(?:bg|border|text)-gray-/);
    expect(cmsPageSource).toContain("text-foreground");
    expect(productShortcodeSource).toContain("bg-card");
  });

  it("keeps embedded product thumbnails uncropped", () => {
    expect(productShortcodeSource).toContain('width: 120, height: 120, quality: 75, format: "auto", fit: "contain"');
    expect(productShortcodeSource).toContain('className="h-full w-full object-contain"');
  });
});
