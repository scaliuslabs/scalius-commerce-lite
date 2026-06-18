import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("category route query boundaries", () => {
  it("keeps category metadata and attribute slug reads in one wave", () => {
    const source = readFileSync(`${ROUTES_DIR}/categories.ts`, "utf8");

    const categoryAttributesWaveIndex = source.indexOf(
      "const [category, allAttributes] = await Promise.all([",
    );
    const categoryReadIndex = source.indexOf(".from(categories)", categoryAttributesWaveIndex);
    const attributesReadIndex = source.indexOf(".from(productAttributes)", categoryAttributesWaveIndex);
    const categoryNotFoundIndex = source.indexOf("if (!category)", categoryAttributesWaveIndex);

    expect(categoryAttributesWaveIndex).toBeGreaterThan(-1);
    expect(categoryReadIndex).toBeGreaterThan(categoryAttributesWaveIndex);
    expect(attributesReadIndex).toBeGreaterThan(categoryAttributesWaveIndex);
    expect(categoryNotFoundIndex).toBeGreaterThan(attributesReadIndex);
  });

  it("keeps category product rows and count in one read wave", () => {
    const source = readFileSync(`${ROUTES_DIR}/categories.ts`, "utf8");

    const countQueryIndex = source.indexOf("let countQuery = db");
    const readWaveIndex = source.indexOf(
      "const [productsList, totalCount] = await Promise.all([",
    );
    const rowsReadIndex = source.indexOf(".orderBy(orderBy)", readWaveIndex);
    const countReadIndex = source.indexOf("countQuery.get()", readWaveIndex);
    const oldSequentialReadIndex = source.indexOf("const productsList = await query");

    expect(countQueryIndex).toBeGreaterThan(-1);
    expect(readWaveIndex).toBeGreaterThan(countQueryIndex);
    expect(rowsReadIndex).toBeGreaterThan(readWaveIndex);
    expect(countReadIndex).toBeGreaterThan(readWaveIndex);
    expect(oldSequentialReadIndex).toBe(-1);
  });
});
