import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES = [
  "./products/$productId/index.tsx",
  "./products/$productId/edit.tsx",
  "./categories/$categoryId/edit.tsx",
  "./collections/$collectionId/edit.tsx",
] as const;

describe("catalog detail loader failure boundaries", () => {
  it.each(ROUTES)("preserves non-404 failures in %s", (relativePath) => {
    const source = readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf8",
    );

    expect(source).toContain(".catch(nullForAdminApiNotFound)");
    expect(source.match(/\.catch\(nullForAdminApiNotFound\)/g)).toHaveLength(1);
  });
});
