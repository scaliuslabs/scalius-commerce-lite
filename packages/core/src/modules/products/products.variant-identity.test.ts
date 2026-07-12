import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const identitySource = readFileSync(
    new URL("./products.variant-identity.ts", import.meta.url),
    "utf8",
);
const productSource = readFileSync(
    new URL("./products.variants.ts", import.meta.url),
    "utf8",
);
const adminSource = readFileSync(
    new URL("./products.admin.ts", import.meta.url),
    "utf8",
);
const scannerSource = readFileSync(
    new URL("../inventory/stock-adjustment.ts", import.meta.url),
    "utf8",
);

describe("product variant identity index boundaries", () => {
    it("states the complete partial-index predicate in one shared helper", () => {
        expect(identitySource).toContain("productVariants.barcode} IS NOT NULL");
        expect(identitySource).toContain("trim(${productVariants.barcode}) <> ''");
        expect(identitySource).toContain("lower(trim(${productVariants.barcode}))");
    });

    it("routes editor, search, and scanner barcode reads through the indexed helper", () => {
        expect(productSource).toContain("productVariantBarcodeIdentityIn([...ownerByKey.keys()])");
        expect(productSource).toContain("productVariantBarcodeIdentityEquals(barcodeKey)");
        expect(adminSource.match(/productVariantBarcodeIdentityEquals\(barcodeKey\)/g)).toHaveLength(2);
        expect(scannerSource).toContain("productVariantBarcodeIdentityEquals(barcodeIdentity)");
    });
});
