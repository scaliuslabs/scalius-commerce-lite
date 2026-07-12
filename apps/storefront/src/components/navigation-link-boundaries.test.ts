import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const component = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("storefront navigation link boundaries", () => {
  it("renders label-only navigation nodes without fake hash links", () => {
    for (const source of [
      component("./header/DesktopNav.astro"),
      component("./header/RecursiveDesktopNav.astro"),
      component("./header/MobileMenu.astro"),
      component("./RecursiveFooterLink.astro"),
    ]) {
      expect(source).not.toContain('href={item.href || "#"}');
      expect(source).not.toContain('href={level2Item.href || "#"}');
      expect(source).not.toContain('href={level3Item.href || "#"}');
      expect(source).toContain(".href ? (");
    }
  });
});
