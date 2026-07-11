import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const variantsSource = readFileSync(
  new URL("./products.variants.ts", import.meta.url),
  "utf8",
);
describe("variant bulk persistence boundaries", () => {
  it("routes bulk creates through the atomic edit-plan transaction", () => {
    expect(variantsSource).toContain(
      "const result = await applyVariantEditPlan(",
    );
    expect(variantsSource).toContain("creates: variants");
    expect(variantsSource).toContain("variants: result.created");
  });

  it("rejects duplicate update IDs before database work", () => {
    const duplicateGuard = variantsSource.indexOf(
      "new Set(updateIds).size !== updateIds.length",
    );
    const currentVariantRead = variantsSource.indexOf(
      "const currentVariants = await db",
    );

    expect(duplicateGuard).toBeGreaterThan(-1);
    expect(currentVariantRead).toBeGreaterThan(duplicateGuard);
    expect(variantsSource).toContain(
      "Each variant may appear only once in an edit plan.",
    );
  });
});
