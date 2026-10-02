// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LUCIDE_ICONS } from "./lucide-icons";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function astroFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return astroFiles(path);
    return name.endsWith(".astro") ? [path] : [];
  });
}

describe("Lucide icons drawn by Astro", () => {
  it("match the installed lucide-react icon nodes", async () => {
    for (const [name, nodes] of Object.entries(LUCIDE_ICONS)) {
      const module = await import(/* @vite-ignore */ `lucide-react/dist/esm/icons/${name}.mjs`) as {
        __iconNode: Array<[string, Record<string, string>]>;
      };
      const expected = module.__iconNode.map(([tag, { key: _key, ...attributes }]) => [tag, attributes]);
      expect(nodes, name).toEqual(expected);
    }
  });

  it("are never rendered through React in Astro components", () => {
    // A React component in .astro is a React render per icon on every page.
    const offenders = astroFiles(SRC).filter((path) => /from\s+["']lucide-react["']/.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
  });
});
