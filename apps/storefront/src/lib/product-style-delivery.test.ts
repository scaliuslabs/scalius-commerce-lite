import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

import {
  isBuildScopedGlobalStylesheet,
  PRODUCT_STYLESHEET_DEFERRAL,
} from "./product-style-delivery";

describe("product stylesheet delivery", () => {
  it("accepts only immutable build-scoped global stylesheet paths", () => {
    expect(
      isBuildScopedGlobalStylesheet(
        "/_astro/src-b9f2c61646e34bb6/global.CntBQevr.css",
      ),
    ).toBe(true);

    for (const href of [
      "/global.css",
      "/_astro/global.css",
      "/_astro/src-current/global.hash.css",
      "/_astro/src-b9f2c61646e34bb6/page.hash.css",
      "https://evil.example/global.hash.css",
      '/_astro/src-b9f2c61646e34bb6/global.hash.css"><script>',
      null,
    ]) {
      expect(isBuildScopedGlobalStylesheet(href)).toBe(false);
    }
  });

  it("uses a non-render-blocking preload with a no-lag priority", () => {
    expect(PRODUCT_STYLESHEET_DEFERRAL).toEqual({
      rel: "preload",
      as: "style",
      fetchpriority: "high",
      marker: "data-product-shared-styles",
      mobileMedia: "(max-width: 39.999rem)",
      desktopMedia: "(min-width: 40rem)",
      onload: "this.onload=null;this.rel='stylesheet'",
    });
  });

  it("keeps the phone paint sheet free of the complete typography plugin", () => {
    const criticalSource = readFileSync(
      storefrontSourcePath("styles", "product-critical.css"),
      "utf8",
    );

    expect(criticalSource).not.toContain('@plugin "@tailwindcss/typography"');
    expect(criticalSource).toContain(".prose-sm");
    expect(criticalSource).toContain("margin-block: 1.25em");
  });
});
