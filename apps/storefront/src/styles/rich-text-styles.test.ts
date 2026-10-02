// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Rich text (Typography's `.prose`) is its own sheet (rich-text.css), built
// from an explicit candidate list and linked only by pages that render rich
// text (RichTextStyles.astro). A `prose` class that is not in the list would
// render unstyled, and the shared sheet must never carry the plugin again.
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sourceFiles(path);
    return /\.(astro|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const css = readFileSync(join(SRC, "styles", "rich-text.css"), "utf8");
const inline = /@source inline\("([^"]+)"\)/.exec(css)?.[1]?.split(/\s+/) ?? [];

describe("rich-text stylesheet", () => {
  it("lists every prose class the sources use", () => {
    const used = new Set<string>();
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      // Class lists live in quotes, template literals and class attributes.
      for (const list of text.matchAll(/(?:class(?:Name)?=|["'`])([^"'`]*\bprose\b[^"'`]*)/g)) {
        for (const token of list[1]!.split(/\s+/)) {
          if (/^(?:[\w-]+:)*(?:prose|prose-[\w-]+)(?::[\w\/.\[\]-]+)?$/.test(token)) used.add(token);
        }
      }
    }
    expect([...used].filter((token) => !inline.includes(token)).sort()).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });

  it("keeps Typography out of the sheet every page loads", () => {
    const global = readFileSync(join(SRC, "styles", "global.css"), "utf8");
    expect(global).not.toMatch(/@plugin\s+['"]@tailwindcss\/typography['"]/);
    expect(global).not.toMatch(/^\.prose\b/m);
    expect(css).toMatch(/@plugin\s+['"]@tailwindcss\/typography['"]/);
    // Every prose rule sits in a layer the utilities outrank, as when it was sorted before them.
    expect(css).toMatch(/layer\(utilities\.prose\)/);
  });

  it("is linked by every page and component that renders rich text", () => {
    for (const file of [
      "components/RichContent.astro",
      "components/footer/ColumnsFooter.astro",
      "pages/products/[slug].astro",
      "pages/[slug].astro",
      "pages/blog/[slug].astro",
      "pages/categories/[slug].astro",
      "pages/collections/[id].astro",
      "pages/brands/[slug].astro",
    ]) {
      expect(readFileSync(join(SRC, file), "utf8"), file).toContain("<RichTextStyles");
    }
  });
});
