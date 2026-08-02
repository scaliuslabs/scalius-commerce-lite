import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    new URL("./products.option-matrix.ts", import.meta.url),
    "utf8",
);

describe("option matrix retired-combination restoration boundaries", () => {
    it("reactivates the original row behind version, stock, pool, and deleted-state guards", () => {
        expect(source).toContain("OPTION_MATRIX_RESTORE_CONFLICT");
        expect(source).toContain("${productVariants.version} = ${restored.version}");
        expect(source).toContain("${productVariants.stockVersion} = ${restored.stockVersion}");
        expect(source).toContain("${effectiveRegularReservedStockSql()} = 0");
        expect(source).toContain("${productVariants.preorderStock} = 0");
        expect(source).toContain("${productVariants.deletedAt} IS NOT NULL");
        expect(source).toContain("deletedAt: null");
    });

    it("keeps ordinary omission as soft retirement without clearing historical stock", () => {
        expect(source).toContain("for (const variant of retiringVariants)");
        expect(source).toContain(".set({ deletedAt: sql`unixepoch()`, version:");
        expect(source).not.toContain(".set({ stock: 0, deletedAt: sql`unixepoch()`");
    });
});
