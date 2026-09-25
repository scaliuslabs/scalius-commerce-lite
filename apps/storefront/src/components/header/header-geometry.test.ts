// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STOREFRONT_HEADER_VARIANTS } from "@scalius/shared/storefront-theme";
import {
  HEADER_GEOMETRY,
  HEADER_SPECS,
  headerCondense,
  headerGeometryStyle,
  headerSpec,
} from "./header-variants";

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

describe("header scroll geometry", () => {
  it("reserves exactly what each header loses when it condenses", () => {
    const bar = "var(--hdr-phone-bar) - var(--hdr-phone-bar-condensed)";
    const classicBar = "var(--hdr-classic-bar) - var(--hdr-classic-bar-condensed)";
    for (const variant of Object.keys(STOREFRONT_HEADER_VARIANTS)) {
      const spec = variant === "mall-departments" ? null : headerSpec(variant, {});
      if (!spec) {
        // The classic header: the bar step on phones; on computers the bar
        // step plus the dropdown row when it folds into the bar.
        expect(headerCondense(spec, { foldsMenuRow: true })).toEqual({
          phone: `calc(${bar})`,
          desktop: `calc(${classicBar} + var(--hdr-classic-menu-row))`,
        });
        expect(headerCondense(spec, { foldsMenuRow: false }).desktop).toBe(`calc(${classicBar})`);
        continue;
      }
      // Composed headers: the bar step plus a sticky phone search row; their
      // computer rows never change.
      expect(headerCondense(spec, { foldsMenuRow: true }), variant).toEqual({
        phone: spec.phoneSearch === "sticky" ? `calc(${bar} + var(--hdr-phone-search-row))` : `calc(${bar})`,
        desktop: "0rem",
      });
    }
    expect(HEADER_SPECS["marketplace-search"].phoneSearch).toBe("sticky");
  });

  it("builds every reserved length from the variables the rows paint with", () => {
    const { phoneBar, searchField, phoneSearchGap, classicBar, classicMenuRow } = HEADER_GEOMETRY;
    const style = headerGeometryStyle(headerCondense(null, { foldsMenuRow: true }));
    const vars = Object.fromEntries(style.split("; ").map((entry) => entry.split(": ") as [string, string]));
    expect(vars).toMatchObject({
      "--hdr-phone-bar": phoneBar.expanded,
      "--hdr-phone-bar-condensed": phoneBar.condensed,
      "--hdr-search-field": searchField,
      "--hdr-phone-search-row": `calc(var(--hdr-search-field) + ${phoneSearchGap})`,
      "--hdr-classic-bar": classicBar.expanded,
      "--hdr-classic-bar-condensed": classicBar.condensed,
      "--nav-link-height-fine": classicMenuRow.link.fine,
      "--nav-link-height-coarse": classicMenuRow.link.coarse,
      "--hdr-classic-menu-row": `calc(${classicMenuRow.border} + 2 * ${classicMenuRow.padding} + var(--nav-link-height))`,
    });
    // The row's measured anatomy: py-2 around the menu and a top border.
    const classicSource = source("./variants/ClassicHeader.astro");
    expect(classicSource).toContain('class="header-full-nav-row hidden border-t border-border lg:block"');
    expect(classicSource).toContain('<div class="py-2 flex justify-center relative z-50">');
    // The menu links, the search field and the phone search row paint with the same variables.
    const nav = source("./DesktopNav.astro");
    expect(nav.match(/height: var\(--nav-link-height, 2\.(?:5|75)rem\)/g)).toHaveLength(3);
    expect(nav).not.toMatch(/\.desktop-nav-(?:link|toggle)[^{]*\{[^}]*height: 2\.\d+rem/);
    expect(rulesFor("./HeaderSearch.astro", "hsearch").join("\n")).toContain("height: var(--hdr-search-field, 2.75rem)");
    const layout = source("./HeaderLayout.astro");
    expect(layout).toMatch(/#site-header \{\s*--nav-link-height: var\(--nav-link-height-fine, 2\.5rem\);/);
    expect(layout).toMatch(/@media \(pointer: coarse\) \{\s*#site-header \{\s*--nav-link-height: var\(--nav-link-height-coarse, 2\.75rem\);/);
  });

  it("paints the rows that condense from the same data, and never animates their height", () => {
    // Composed headers: the bar and the sticky search row.
    const composed = "./variants/ComposedHeader.astro";
    const bar = rulesFor(composed, "hdr-bar").join("\n");
    expect(bar).toContain("height: var(--hdr-phone-bar, 3.5rem)");
    expect(bar).toContain("height: var(--hdr-phone-bar-condensed, 3rem)");
    expect(rulesFor(composed, "hdr-phone-search").join("\n")).toContain("height: var(--hdr-phone-search-row, 3.25rem)");
    // The classic header: its bar on phones and computers, and its dropdown row.
    const classic = "./variants/ClassicHeader.astro";
    const row = rulesFor(classic, "header-row").join("\n");
    for (const token of ["--hdr-phone-bar", "--hdr-phone-bar-condensed", "--hdr-classic-bar", "--hdr-classic-bar-condensed"]) {
      expect(row).toContain(`var(${token},`);
    }
    expect(rulesFor(classic, "header-full-nav-row").join("\n")).toContain("height: var(--hdr-classic-menu-row);");
    // A height that animates while the reserve snaps would move the page for
    // a few frames: no transition of a flow size on these rows.
    const flowSize = /transition[^;]*\b(?:height|max-height|min-height|margin|padding)\b/;
    for (const [file, name] of [
      [composed, "hdr-bar"],
      [composed, "hdr-phone-search"],
      [composed, "hdr"],
      [classic, "header-row"],
      [classic, "header-full-nav-row"],
    ] as const) {
      for (const rule of rulesFor(file, name)) expect(rule, `${file} ${rule}`).not.toMatch(flowSize);
    }
    const classicRow = source(classic).match(/class="header-row[^"]*"/)![0];
    expect(classicRow).not.toMatch(/transition|\bh-\d|lg:h-/);
  });

  it("holds the reserve under the condensed header on every width", () => {
    const css = source("./HeaderLayout.astro");
    expect(css).toMatch(/#main-header\.is-scrolled \{\s*margin-bottom: var\(--hdr-condense-phone, 0rem\);/);
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*#main-header\.is-scrolled \{\s*margin-bottom: var\(--hdr-condense-desktop, 0rem\);/);
  });
});
