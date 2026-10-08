// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: without JavaScript the phone header showed the dead menu button
// next to its <noscript> link (two hamburgers) and a search button that opened
// nothing, overlapping the store name. Every JS-only phone control needs a
// <noscript> link, and the layout hides the dead buttons when scripts are off.
// The drawer's close button was hidden by `<style>{`#${id}-close ...`}</style>`,
// which Astro emits as literal text (it never evaluates expressions inside
// <style>), so the dead close button stayed beside its <noscript> link.
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const src = fileURLToPath(new URL("../../", import.meta.url));
const astroSources = (readdirSync(src, { recursive: true }) as string[])
  .filter((path) => path.endsWith(".astro"))
  .map((path) => [path, readFileSync(join(src, path), "utf8")] as const);

const layout = read("../../layouts/Layout.astro");
const headers = {
  composed: read("./variants/ComposedHeader.astro"),
};

describe("phone header without JavaScript", () => {
  it("hides the JS-only menu, search and drawer close buttons", () => {
    expect(layout).toMatch(
      /<noscript><style is:inline>#mobile-menu-toggle,#mobile-search-toggle,\[data-drawer-close\]\{display:none!important\}<\/style><\/noscript>/,
    );
  });

  it("gives the drawer a <noscript> close link and marks its JS-only button", () => {
    const menu = read("./MobileMenu.astro");
    expect(menu).toMatch(/<button\s+id=\{`\$\{id\}-close`\}[^>]*\sdata-drawer-close\s*>/);
    expect(menu).toMatch(/<noscript>\s*<a\s+href="#"/);
  });

  it("never puts an expression inside a <style> element", () => {
    expect(astroSources.length).toBeGreaterThan(0);
    for (const [path, source] of astroSources) {
      for (const [, attributes, body] of source.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)) {
        if (/set:html/.test(attributes!)) continue;
        expect(body!.trimStart().startsWith("{"), path).toBe(false);
        expect(body, path).not.toContain("${");
      }
    }
  });

  it.each(Object.entries(headers))("%s header links the drawer and /search in <noscript>", (_name, source) => {
    expect(source).toContain('id="mobile-menu-toggle"');
    expect(source).toMatch(/<noscript>\s*<a\s+href="#mobile-menu-panel"/);
    expect(source).toContain('id="mobile-search-toggle"');
    expect(source).toMatch(/<noscript>\s*<a\s+href="\/search"/);
  });
});
