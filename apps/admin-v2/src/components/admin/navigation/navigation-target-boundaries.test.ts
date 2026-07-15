import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("typed navigation target boundaries", () => {
  it("offers all commerce resources and writes stable IDs instead of copied hrefs", () => {
    const source = readSource("./AddNavItemDialog.tsx");
    const resourceSource = readSource("./navigation-source.ts");

    expect(source).toContain('| "product"');
    expect(source).toContain('| "collection"');
    expect(source).toContain("createResourceNavigationItem");
    expect(source).toContain('status: "published"');
    expect(resourceSource).toContain("resourceType: source.type");
    expect(resourceSource).toContain("resourceId: source.id");
    expect(resourceSource).toContain("resolution:");
    expect(source).not.toContain("href: cat.url");
    expect(source).not.toContain("href: page.url");
  });

  it("keeps filtered categories as a stable category plus query projection", () => {
    const source = readSource("./AddNavItemDialog.tsx");
    const resourceSource = readSource("./navigation-source.ts");

    expect(source).toContain("createResourceNavigationItem(category");
    expect(source).toContain("customLabel: dynamicLabel");
    expect(source).toContain("query,");
    expect(resourceSource).toContain("parseNavigationQuery(options.query)");
    expect(resourceSource).toContain('labelMode: customLabel ? "custom" : "resource"');
  });
});
