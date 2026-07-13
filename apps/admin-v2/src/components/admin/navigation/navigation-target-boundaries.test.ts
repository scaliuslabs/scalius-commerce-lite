import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("typed navigation target boundaries", () => {
  it("offers all commerce resources and writes stable IDs instead of copied hrefs", () => {
    const source = readSource("./AddNavItemDialog.tsx");

    expect(source).toContain('| "product"');
    expect(source).toContain('| "collection"');
    expect(source).toContain('resourceType: "page"');
    expect(source).toContain('resourceType: "category"');
    expect(source).toContain('resourceType: activeType');
    expect(source).toContain('labelMode: "resource"');
    expect(source).not.toContain("href: cat.url");
    expect(source).not.toContain("href: page.url");
  });

  it("keeps filtered categories as a stable category plus query projection", () => {
    const source = readSource("./AddNavItemDialog.tsx");

    expect(source).toContain('resourceType: "category"');
    expect(source).toContain("...(query ? { query } : {})");
    expect(source).toContain('labelMode: "custom"');
  });
});
