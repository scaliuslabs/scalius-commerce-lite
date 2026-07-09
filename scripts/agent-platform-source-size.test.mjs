import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  "apps/admin-agent/src",
  "apps/storefront-agent/src",
  "apps/admin-v2/src/components/admin/assistant",
  "apps/storefront/src/components/assistant",
  "apps/api/src/modules/ai",
  "apps/api/src/modules/assistant",
  "packages/agent-runtime/src",
  "packages/core/src/modules/assistant",
];
const allowedExtensions = new Set([".astro", ".mjs", ".ts", ".tsx"]);
const maxProductionLines = 999;

function productionSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (!entry.isFile() || !allowedExtensions.has(extname(entry.name))) return [];
    if (/\.(?:spec|test)\.[^.]+$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [path];
  });
}

function selectedChatRouteSources() {
  const selections = [
    ["apps/api/src/routes/admin", /^ai(?:-|\.ts$)/],
    ["apps/api/src/routes", /^storefront-chat(?:-|\.ts$)/],
  ];
  return selections.flatMap(([directory, pattern]) => {
    const absoluteDirectory = resolve(rootDir, directory);
    return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !pattern.test(entry.name)) return [];
      if (/\.(?:spec|test)\.[^.]+$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
      return [join(absoluteDirectory, entry.name)];
    });
  });
}

describe("agent platform production source size", () => {
  it("keeps every owned module below one thousand lines", () => {
    const sources = [
      ...sourceRoots.flatMap((sourceRoot) => productionSources(resolve(rootDir, sourceRoot))),
      ...selectedChatRouteSources(),
    ];
    const oversized = sources.flatMap((path) => {
        const lines = readFileSync(path, "utf8").split(/\r?\n/).length;
        return lines > maxProductionLines
          ? [`${relative(rootDir, path)} (${lines} lines)`]
          : [];
      });

    expect(oversized, "Split oversized agent-platform modules by responsibility").toEqual([]);
  });
});
