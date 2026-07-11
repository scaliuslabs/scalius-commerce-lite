import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const variantsSource = readFileSync(
  new URL("./products.variants.ts", import.meta.url),
  "utf8",
);
const adminSource = readFileSync(
  new URL("./products.admin.ts", import.meta.url),
  "utf8",
);

describe("variant bulk persistence boundaries", () => {
  it("commits all parameter-safe create chunks in one D1 batch", () => {
    expect(variantsSource).toContain("const insertStatements = []");
    expect(variantsSource).toContain(
      "await safeBatch(db, insertStatements as never)",
    );
    expect(variantsSource).not.toContain("createdVariants.push(...result)");
  });

  it("rejects duplicate update IDs before database work", () => {
    const duplicateGuard = adminSource.indexOf(
      "new Set(ids).size !== ids.length",
    );
    const currentVariantRead = adminSource.indexOf(
      "const currentVariants = ids.length > 0",
    );

    expect(duplicateGuard).toBeGreaterThan(-1);
    expect(currentVariantRead).toBeGreaterThan(duplicateGuard);
    expect(adminSource).toContain(
      "Each variant may appear only once in a bulk update.",
    );
  });
});
