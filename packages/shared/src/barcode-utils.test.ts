import { describe, expect, it } from "vitest";

import { generateEAN13, validateEAN13 } from "./barcode-utils";

describe("barcode utilities", () => {
  it("generates valid internal-use EAN-13 values", () => {
    const generated = Array.from({ length: 100 }, () => generateEAN13());

    expect(generated.every((barcode) => barcode.startsWith("200"))).toBe(true);
    expect(generated.every(validateEAN13)).toBe(true);
    expect(new Set(generated).size).toBeGreaterThan(95);
  });
});
