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
    expect(productShortcodeSource).toContain('width: 120, height: 120, quality: 75, format: "auto", fit: "contain"');
    expect(productShortcodeSource).toContain('className="h-full w-full object-contain"');
  });

  it("offers a near-device-width featured image before larger CMS candidates", () => {
    expect(cmsPageSource).toContain("[384, 192]");
    expect(cmsPageSource).toContain("[768, 384]");
    expect(cmsPageSource).toContain(
      "quality: width <= 768 ? 72 : width === 960 ? 78 : 82",
    );
  });
});
