// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serializeJsonForInlineScript } from "./safe-json";

describe("serializeJsonForInlineScript", () => {
  it("keeps JSON parseable while preventing inline script breakout", () => {
    const payload = {
      gateway: {
        name: '</script><img src=x onerror="window.__pwned=true">',
        note: "line\u2028separator & paragraph\u2029separator",
      },
    };

    const serialized = serializeJsonForInlineScript(payload);
    const inlineScript = `window.__CHECKOUT_CONFIG__=${serialized};`;
    const doc = new DOMParser().parseFromString(
      `<script>${inlineScript}</script>`,
      "text/html",
    );

    expect(serialized).not.toContain("</script");
    expect(serialized).not.toContain("<img");
    expect(inlineScript).not.toContain("</script");
    expect(doc.querySelectorAll("script")).toHaveLength(1);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("script")?.textContent).toContain(
      "\\u003C/script",
    );
    expect(JSON.parse(serialized)).toEqual(payload);
  });

  it("is safe for JSON-LD and application/json script islands", () => {
    const payload = {
      name: '</script><img src=x onerror="window.__pwned=true">',
    };
    const serialized = serializeJsonForInlineScript(payload);

    for (const type of ["application/ld+json", "application/json"]) {
      const doc = new DOMParser().parseFromString(
        `<script type="${type}">${serialized}</script>`,
        "text/html",
      );

      expect(doc.querySelectorAll("script")).toHaveLength(1);
      expect(doc.querySelector("img")).toBeNull();
      expect(doc.querySelector("script")?.textContent).toContain(
        "\\u003C/script",
      );
    }
  });
});

describe("storefront inline JSON source boundaries", () => {
  const workspaceRoot = process.cwd().endsWith("/apps/storefront")
    ? process.cwd().replace(/\/apps\/storefront$/, "")
    : process.cwd();
  const storefrontSrcRoot = join(workspaceRoot, "apps/storefront/src");
  const checkedFiles = [
    "layouts/Layout.astro",
    "components/Footer.astro",
    "components/product/ProductSummary.astro",
    "pages/products/[slug].astro",
    "pages/categories/[slug].astro",
    "pages/collections/[id].astro",
    "pages/buy/[slug].ts",
  ];

  it("does not place raw JSON.stringify output directly in inline script HTML", () => {
    for (const file of checkedFiles) {
      const source = readFileSync(join(storefrontSrcRoot, file), "utf8");

      expect(source, file).not.toMatch(/set:html=\{JSON\.stringify/);
      expect(source, file).not.toMatch(/JsonLd\s*=\s*JSON\.stringify/);
      expect(source, file).not.toContain("JSON.stringify(${JSON.stringify");
    }
  });
});
