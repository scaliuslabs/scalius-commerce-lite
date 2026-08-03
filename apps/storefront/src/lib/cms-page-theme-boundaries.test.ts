import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cmsPageSource = readFileSync(
  resolve(process.cwd(), "src/pages/[slug].astro"),
  "utf8",
);
const productShortcodeSource = readFileSync(
  resolve(process.cwd(), "src/components/ProductShortcode.tsx"),
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
