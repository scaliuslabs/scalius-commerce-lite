import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const cmsPageSource = readFileSync(
  storefrontSourcePath("pages", "[slug].astro"),
  "utf8",
);
const productShortcodeSource = readFileSync(
  storefrontSourcePath("components", "ProductShortcode.tsx"),
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
    expect(productShortcodeSource).toContain('className="h-full w-full object-contain"');
  });

  it("offers every featured image rendition with a stable 2:1 crop", () => {
    expect(cmsPageSource).toContain("mediaImageSrcSet(featuredImage.url)");
    expect(cmsPageSource.match(/aspect-\[2\/1\]/g)).toHaveLength(2);
  });
});
