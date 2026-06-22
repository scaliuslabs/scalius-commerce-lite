import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = (() => {
  const packageRelative = process.cwd();
  if (existsSync(join(packageRelative, "src/pages"))) return packageRelative;
  return join(process.cwd(), "apps/storefront");
})();

function listAstroFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listAstroFiles(path));
    } else if (path.endsWith(".astro")) {
      files.push(path);
    }
  }

  return files;
}

describe("storefront layout landmarks", () => {
  it("keeps Layout-owned pages from rendering nested main landmarks", () => {
    const layoutSource = readFileSync(
      join(storefrontRoot, "src/layouts/Layout.astro"),
      "utf8",
    );
    expect(layoutSource.match(/<main\b/g) ?? []).toHaveLength(1);
    expect(layoutSource.match(/<\/main>/g) ?? []).toHaveLength(1);

    const layoutPagesWithMain = listAstroFiles(join(storefrontRoot, "src/pages"))
      .map((file) => ({
        file,
        source: readFileSync(file, "utf8"),
      }))
      .filter(({ source }) => source.includes("<Layout"))
      .filter(({ source }) => /<\/?main\b/.test(source))
      .map(({ file }) => relative(storefrontRoot, file));

    expect(layoutPagesWithMain).toEqual([]);
  });

  it("does not bind client behavior to a page-owned main tag", () => {
    const pageSources = listAstroFiles(join(storefrontRoot, "src/pages"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(pageSources).not.toContain("main[data-products-for-analytics]");
    expect(pageSources).not.toContain("querySelector(\"main");
    expect(pageSources).not.toContain("querySelector<HTMLElement>(\n      \"main");
  });
});
