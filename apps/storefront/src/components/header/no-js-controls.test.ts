// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: without JavaScript the phone header showed the dead menu button
// next to its <noscript> link (two hamburgers) and a search button that opened
// nothing, overlapping the store name. Every JS-only phone control needs a
// <noscript> link, and the layout hides the dead buttons when scripts are off.
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const layout = read("../../layouts/Layout.astro");
const headers = {
  classic: read("./variants/ClassicHeader.astro"),
  composed: read("./variants/ComposedHeader.astro"),
};

describe("phone header without JavaScript", () => {
  it("hides the JS-only menu and search buttons", () => {
    expect(layout).toMatch(
      /<noscript><style is:inline>#mobile-menu-toggle,#mobile-search-toggle\{display:none!important\}<\/style><\/noscript>/,
    );
  });

  it.each(Object.entries(headers))("%s header links the drawer and /search in <noscript>", (_name, source) => {
    expect(source).toContain('id="mobile-menu-toggle"');
    expect(source).toMatch(/<noscript>\s*<a\s+href="#mobile-menu-panel"/);
    expect(source).toContain('id="mobile-search-toggle"');
    expect(source).toMatch(/<noscript>\s*<a\s+href="\/search"/);
  });
});
