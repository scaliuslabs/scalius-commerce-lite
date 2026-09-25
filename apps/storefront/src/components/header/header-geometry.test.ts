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
    const { phoneBar, phoneSearchRow, classicBar, classicMenuRow } = HEADER_GEOMETRY;
    const barDelta = phoneBar.expanded - phoneBar.condensed;
    // Every variant has a reserve; composed variants lose the bar step plus
    // their sticky phone search row, and nothing on computers.
    for (const variant of Object.keys(STOREFRONT_HEADER_VARIANTS)) {
      const spec = variant === "mall-departments" ? null : headerSpec(variant, {});
      const reserve = headerCondense(spec, { foldsMenuRow: true });
      if (!spec) {
        expect(reserve).toEqual({ phone: barDelta, desktop: classicBar.expanded - classicBar.condensed + classicMenuRow });
        expect(headerCondense(spec, { foldsMenuRow: false }).desktop).toBe(classicBar.expanded - classicBar.condensed);
        continue;
      }
      expect(reserve, variant).toEqual({
        phone: barDelta + (spec.phoneSearch === "sticky" ? phoneSearchRow : 0),
        desktop: 0,
      });
    }
    expect(headerCondense(HEADER_SPECS["marketplace-search"], { foldsMenuRow: false }).phone).toBe(3.75);
    expect(headerGeometryStyle({ phone: 3.75, desktop: 0 })).toContain("--hdr-condense-phone: 3.75rem");
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
    expect(rulesFor(classic, "header-full-nav-row").join("\n")).toContain("height: var(--hdr-classic-menu-row, 3.5625rem)");
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
