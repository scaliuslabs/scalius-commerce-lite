import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (entry.name.endsWith(".d.ts") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

/** `import logo from "~/assets/logo.png"` — a URL built at the host root. */
const ASSET_IMPORT = /import\s+(\w+)\s+from\s+"[~@]\/assets\/[^"]+"/gu;

describe("bundled asset URLs below a dashboard path prefix", () => {
  it("routes every imported asset URL through the runtime base path", () => {
    // Vite builds these URLs at the host root. When the dashboard is served
    // below a prefix, a bare one resolves against the wrong origin path and
    // never reaches this Worker at all, so each use has to be prefixed. The
    // prefix is per request, so it is applied at the use site, never hoisted
    // into module state.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const [statement, binding] of source.matchAll(ASSET_IMPORT)) {
        // Remove the import itself and every already-prefixed use; whatever
        // still mentions the binding is a bare, host-root URL.
        const remaining = source
          .replace(statement, "")
          .replaceAll(new RegExp(`withDashboardBasePath\\(\\s*${binding}\\s*\\)`, "gu"), "");
        if (new RegExp(`\\b${binding}\\b`, "u").test(remaining)) {
          offenders.push(`${relative(SRC_ROOT, file)}: ${binding}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
