import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const storefrontRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("storefront browser API URL policy", () => {
  it("does not silently fall back to a nonexistent same-origin /api/v1 proxy", async () => {
    const files = [
      "src/lib/api/client.ts",
      "src/layouts/Layout.astro",
      "src/components/AuthModal.tsx",
      "src/components/search/CommandPalette.tsx",
    ];

    const sources = await Promise.all(
      files.map((file) => readFile(join(storefrontRoot, file), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/\|\|\s*["']\/api\/v1["']/);
      expect(source).not.toMatch(/return\s+["']\/api\/v1["']/);
    }
  });
});
