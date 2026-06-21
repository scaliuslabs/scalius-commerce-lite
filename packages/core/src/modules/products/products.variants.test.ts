import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { bulkCreateVariants, createVariant } from "./products.variants";

const db = {} as never;

const baseVariant = {
    size: "M",
    color: null,
    weight: null,
    sku: "SKU-1",
    price: 100,
    stock: 5,
    trackInventory: true,
    barcode: null,
    barcodeType: null,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: null,
};

describe("product variant SKU rules", () => {
    it("rejects merchant-created variants without customer options", async () => {
        await expect(createVariant(db, "prod_1", {
            ...baseVariant,
            size: null,
            color: null,
        })).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects bulk-created variants without customer options", async () => {
        await expect(bulkCreateVariants(db, "prod_1", [{
            ...baseVariant,
            size: "",
            color: null,
        }])).rejects.toBeInstanceOf(ValidationError);
    });
});
