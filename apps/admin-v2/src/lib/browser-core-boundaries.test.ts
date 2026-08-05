import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_SRC_ROOT = join(import.meta.dirname, "..");

function collectBrowserSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectBrowserSourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (/\.(?:test|server)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("admin browser/core boundaries", () => {
  it("imports runtime values from browser-safe core leaves, not server-heavy module barrels", () => {
    const violations: string[] = [];
    const broadCoreModule = /^@scalius\/core\/modules\/[^/]+$/;
    const staticImport = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g;

    for (const file of collectBrowserSourceFiles(ADMIN_SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const clause = match[1]?.trim() ?? "";
        const specifier = match[2] ?? "";
        if (broadCoreModule.test(specifier) && !clause.startsWith("type ")) {
          violations.push(`${relative(ADMIN_SRC_ROOT, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
