import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const componentRoot = join(import.meta.dirname);

function component(path: string): string {
  return readFileSync(join(componentRoot, path), "utf8");
}

describe("icon-only social links", () => {
  const sources = [
    component("header/HeaderLayout.astro"),
    component("header/MobileMenu.astro"),
    component("Footer.astro"),
  ];

  it("gives each link one explicit accessible name", () => {
    for (const source of sources) {
      expect(source).toContain("aria-label={displayTitle}");
      expect(source).not.toContain("alt={displayTitle}");
      expect(source).not.toContain('<span class="sr-only">{displayTitle}</span>');
    }
  });

  it("keeps icon images and fallback glyphs decorative", () => {
    for (const source of sources) {
      expect(source).toMatch(/alt=""\s+aria-hidden="true"/u);
      expect(source).toMatch(/<span aria-hidden="true"/u);
    }
  });

  it("names the footer logo destination independently of its media filename", () => {
    expect(component("Footer.astro")).toMatch(
      /<a\s+href="\/"[\s\S]*?aria-label="Go to homepage"/u,
    );
  });
});
