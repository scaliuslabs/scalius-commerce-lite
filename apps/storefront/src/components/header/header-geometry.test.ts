// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STOREFRONT_HEADER_VARIANTS } from "@scalius/shared/storefront-theme";
import { HEADER_GEOMETRY, headerCondense, headerGeometryStyle, headerSpec } from "./header-variants";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** CSS rules of a component's <style> blocks whose selector names `className`. */
function rulesFor(file: string, className: string): string[] {
  const css = [...source(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const named = new RegExp(`\\.${className}(?![\\w-])`);
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => named.test(selector!))
    .map(([, selector, body]) => `${selector!.trim()} { ${body!.trim()} }`);
}

const COMPOSED = "./variants/ComposedHeader.astro";

describe("header scroll geometry", () => {
  it("reserves exactly what each layout loses when it condenses", () => {
    const bar = "var(--hdr-phone-bar) - var(--hdr-phone-bar-condensed)";
    for (const variant of Object.keys(STOREFRONT_HEADER_VARIANTS)) {
      const spec = headerSpec(variant, {});
      // The bar step, plus the sticky phone search row where the layout has one.
      expect(headerCondense(spec), variant).toEqual({
        phone: spec.phoneSearch === "sticky" ? `calc(${bar} + var(--hdr-phone-search-row))` : `calc(${bar})`,
      });
    }
    expect(headerSpec("search-first", {}).phoneSearch).toBe("sticky");
    expect(headerSpec("inline-nav", {}).phoneSearch).toBe("none");
    expect(headerSpec("centered-logo", {}).phoneSearch).toBe("none");
  });

  it("reads the layout's settings and fits the search to the layout", () => {
    expect(headerSpec("inline-nav", { search: "field", rowTone: "header", cartTotal: true })).toMatchObject({
      menu: "inline", search: "field", toneRow: true, cartTotal: true,
    });
    expect(headerSpec("search-first", { search: "scoped" })).toMatchObject({ menu: "row", search: "scoped", toneRow: false });
    // A search-first header always has a field (an icon would not be "first").
    expect(headerSpec("search-first", { search: "icon" }).search).toBe("field");
    expect(headerSpec("centered-logo", {})).toMatchObject({ menu: "row", search: "icon" });
  });

  it("builds every reserved length from the variables the rows paint with", () => {
    const { phoneBar, searchField, phoneSearchGap, navLink } = HEADER_GEOMETRY;
    const style = headerGeometryStyle(headerCondense(headerSpec("search-first", {})));
    const vars = Object.fromEntries(style.split("; ").map((entry) => entry.split(": ") as [string, string]));
    expect(vars).toMatchObject({
      "--hdr-phone-bar": phoneBar.expanded,
      "--hdr-phone-bar-condensed": phoneBar.condensed,
      "--hdr-search-field": searchField,
      "--hdr-phone-search-row": `calc(var(--hdr-search-field) + ${phoneSearchGap})`,
      "--nav-link-height-fine": navLink.fine,
      "--nav-link-height-coarse": navLink.coarse,
    });
    // The menu links, the search field and the phone search row paint with the same variables.
    const nav = source("./DesktopNav.astro");
    expect(nav.match(/height: var\(--nav-link-height, 2\.(?:5|75)rem\)/g)).toHaveLength(3);
    expect(nav).not.toMatch(/\.desktop-nav-(?:link|toggle)[^{]*\{[^}]*height: 2\.\d+rem/);
    expect(rulesFor("./HeaderSearch.astro", "hsearch").join("\n")).toContain("height: var(--hdr-search-field, 2.75rem)");
    const layout = source("./HeaderLayout.astro");
    expect(layout).toMatch(/#site-header \{\s*--nav-link-height: var\(--nav-link-height-fine, 2\.5rem\);/);
    expect(layout).toMatch(/@media \(pointer: coarse\) \{\s*#site-header \{\s*--nav-link-height: var\(--nav-link-height-coarse, 2\.75rem\);/);
  });

  it("paints the rows that condense from the same data, easing only with the reserve's transition", () => {
    const bar = rulesFor(COMPOSED, "hdr-bar").join("\n");
    expect(bar).toContain("height: var(--hdr-phone-bar, 3.5rem)");
    expect(bar).toContain("height: var(--hdr-phone-bar-condensed, 3rem)");
    expect(rulesFor(COMPOSED, "hdr-phone-search").join("\n")).toContain("height: var(--hdr-phone-search-row, 3.25rem)");
    // A height that eased on its own timing while the reserve used another
    // would move the page for a few frames: every transition of a flow size
    // on these rows uses the shared condense duration and easing.
    const flowSize = /^(?:height|max-height|min-height|margin[\w-]*|padding[\w-]*)\s/;
    const sharedTiming = /\svar\(--hdr-condense-duration, [^)]*\)\s+var\(--hdr-condense-easing, /;
    const seen = new Set<string>();
    const checked: string[] = [];
    for (const name of ["hdr-bar", "hdr-phone-search", "hdr"]) {
      for (const rule of rulesFor(COMPOSED, name)) {
        if (seen.has(rule)) continue;
        seen.add(rule);
        const transition = /transition:([^;]*);/.exec(rule)?.[1];
        if (!transition) continue;
        // Top-level entries (commas inside var(...) and cubic-bezier(...) stay).
        for (const entry of transition.split(/,(?![^(]*\))/).map((part) => part.trim())) {
          if (!flowSize.test(entry)) continue;
          checked.push(entry.split(/\s/)[0]!);
          expect(entry, rule).toMatch(sharedTiming);
        }
      }
    }
    // The bar, and the sticky search row (its height and bottom padding).
    expect(checked).toEqual(["height", "height", "padding-bottom"]);
  });

  it("holds the reserve under the condensed header", () => {
    const css = source("./HeaderLayout.astro");
    expect(css).toMatch(/#main-header\.is-scrolled \{\s*margin-bottom: var\(--hdr-condense-phone, 0rem\);/);
    // Computers keep their rows as they are: nothing to reserve there.
    expect(css).not.toContain("--hdr-condense-desktop");
    // The reserve eases with the rows (0s for everything under reduced motion).
    expect(css).toMatch(/#main-header \{\s*transition-property: margin-bottom[^;]*;\s*transition-duration: var\(--hdr-condense-duration, 300ms\);\s*transition-timing-function: var\(--hdr-condense-easing,/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*#site-header \{\s*--hdr-condense-duration: 0s;/);
    expect(headerGeometryStyle(headerCondense(headerSpec("inline-nav", {})))).toContain(
      `--hdr-condense-motion: ${HEADER_GEOMETRY.condense.duration}; --hdr-condense-easing: ${HEADER_GEOMETRY.condense.easing}`,
    );
  });
});
