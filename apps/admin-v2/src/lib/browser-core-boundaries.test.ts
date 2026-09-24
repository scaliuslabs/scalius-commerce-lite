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
  it("imports @scalius/core domains only through their browser entries", () => {
    const violations: string[] = [];
    const coreModuleImport = /(?:import|export)\s+[\s\S]*?\s+from\s+["'](@scalius\/core\/modules\/[^"']+)["']/g;

    for (const file of collectBrowserSourceFiles(ADMIN_SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(coreModuleImport)) {
        const specifier = match[1] ?? "";
        if (!/^@scalius\/core\/modules\/[^/]+\/browser$/.test(specifier)) {
          violations.push(`${relative(ADMIN_SRC_ROOT, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
