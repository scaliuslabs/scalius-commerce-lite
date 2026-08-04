import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (
      extname(entry.name) !== ".ts"
      || entry.name.endsWith(".test.ts")
      || entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [path];
  });
}

describe("database provider boundaries", () => {
  it("keeps D1 implementation types out of commerce feature code", () => {
    const violations = productionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("drizzle-orm/d1") || source.includes("D1Database")
        ? [relative(SOURCE_ROOT, path)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
