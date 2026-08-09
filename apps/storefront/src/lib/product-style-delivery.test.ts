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

  it("uses one naturally low-priority phone sheet and a blocking desktop branch", () => {
    expect(PRODUCT_STYLESHEET_DEFERRAL).toEqual({
      rel: "stylesheet",
      marker: "data-product-shared-styles",
      mobileMedia: "(max-width: 39.999rem)",
      desktopMedia: "(min-width: 40rem)",
      initialMedia: "print, (min-width: 40rem)",
      onload:
        "this.onload=null;if(matchMedia('(max-width: 39.999rem)').matches){const a=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{this.media='(max-width: 39.999rem)'}));document.readyState==='complete'?a():window.addEventListener('load',a,{once:true})}",
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

  it("discovers the product image before parsing the phone paint sheet", () => {
    const layout = readFileSync(
      storefrontSourcePath("layouts", "Layout.astro"),
      "utf8",
    );
    const product = readFileSync(
      storefrontSourcePath("pages", "products", "[slug].astro"),
      "utf8",
    );

    expect(product).toContain('<Fragment slot="preload">');
    expect(layout.indexOf('<slot name="preload" />')).toBeLessThan(
      layout.indexOf("criticalCss &&"),
    );
  });
});
