import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
    bulkCreateVariants,
    bulkDeleteVariants,
    createVariant,
    deleteVariant,
    getVariantSortOrder,
    lookupByBarcode,
    updateVariant,
} from "./products.variants";

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

    it("rejects deleting the protected simple product SKU through generic variant delete", async () => {
        let deleteCalled = false;
        const dbWithProtectedSku = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => ({ id: "var_default", isDefault: true }),
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            deleteVariant(dbWithProtectedSku as never, "prod_1", "var_default"),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(deleteCalled).toBe(false);
    });

    it("rejects bulk deleting the protected simple product SKU", async () => {
        let deleteCalled = false;
        const dbWithProtectedSku = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => ({ id: "var_default" }),
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            bulkDeleteVariants(dbWithProtectedSku as never, "prod_1", ["var_default"]),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(deleteCalled).toBe(false);
    });

    it("rejects deleting the final customer option from an active product", async () => {
        let selectCount = 0;
        let deleteCalled = false;
        const dbWithFinalOption = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return { id: "var_option", isDefault: false };
                                        }
                                        if (selectCount === 2) {
                                            return { isActive: true };
                                        }
                                        return { count: 0 };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            deleteVariant(dbWithFinalOption as never, "prod_1", "var_option"),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(deleteCalled).toBe(false);
    });

    it("rejects bulk deleting the final customer option from an active product", async () => {
        let selectCount = 0;
        let deleteCalled = false;
        const dbWithFinalOption = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) return null;
                                        if (selectCount === 2) return { isActive: true };
                                        return { count: 0 };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            bulkDeleteVariants(dbWithFinalOption as never, "prod_1", ["var_option"]),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(deleteCalled).toBe(false);
    });

    it("rejects non-default SKUs that still have no customer option", async () => {
        const dbWithInvalidSku = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => ({
                                        id: "var_bad",
                                        isDefault: false,
                                        size: null,
                                        color: null,
                                        stock: 0,
                                        stockVersion: 1,
                                        trackInventory: false,
                                    }),
                                };
                            },
                        };
                    },
                };
            },
        };

        await expect(
            updateVariant(dbWithInvalidSku as never, "prod_1", "var_bad", {
                ...baseVariant,
                size: null,
                color: null,
            }),
        ).rejects.toBeInstanceOf(ValidationError);
    });

    it("keeps product pricing authoritative when updating the simple SKU", async () => {
        let selectCount = 0;
        let updateValues: Record<string, unknown> | undefined;
        const dbWithSimpleSku = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return {
                                                id: "var_default",
                                                isDefault: true,
                                                size: null,
                                                color: null,
                                                stock: 0,
                                                stockVersion: 1,
                                                trackInventory: false,
                                            };
                                        }
                                        if (selectCount === 2) return null;
                                        return { price: 321 };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return {
                    set(values: Record<string, unknown>) {
                        updateValues = values;
                        return {
                            where() {
                                return {
                                    returning: async () => [{ id: "var_default", ...values }],
                                };
                            },
                        };
                    },
                };
            },
        };

        await updateVariant(dbWithSimpleSku as never, "prod_1", "var_default", {
            ...baseVariant,
            size: null,
            color: null,
            price: 999,
            stock: 0,
            trackInventory: false,
            discountType: "flat",
            discountAmount: 50,
            discountPercentage: null,
        });

        expect(updateValues).toMatchObject({
            price: 321,
            discountType: "percentage",
            discountPercentage: 0,
            discountAmount: 0,
            trackInventory: false,
        });
    });

    it("normalizes default SKU option labels in barcode lookup without hiding real option labels", async () => {
        const makeDb = (variantRow: Record<string, unknown>) => ({
            select() {
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            get: async () => variantRow,
                                        };
                                    },
                                };
                            },
                        };
                    },
                };
            },
        });
        const baseBarcodeRow = {
            variantId: "var_default_prod_1",
            variantSku: "SIMPLE-prod_1",
            variantWeight: null,
            variantPrice: 100,
            variantStock: 0,
            variantReservedStock: 0,
            variantBarcode: "123",
            variantBarcodeType: "code128",
            productId: "prod_1",
            productName: "Demo",
            productSlug: "demo",
            productPrice: 100,
            productIsActive: true,
        };

        const defaultResult = await lookupByBarcode(makeDb({
            ...baseBarcodeRow,
            variantSize: "Default",
            variantColor: "Default",
            variantIsDefault: true,
        }) as never, "123");
        const optionResult = await lookupByBarcode(makeDb({
            ...baseBarcodeRow,
            variantId: "var_option_1",
            variantSku: "OPT-1",
            variantSize: "2KG",
            variantColor: "Red",
            variantIsDefault: false,
        }) as never, "123");

        expect(defaultResult?.variant).toMatchObject({ size: null, color: null });
        expect(optionResult?.variant).toMatchObject({ size: "2KG", color: "Red" });
    });

    it("excludes protected default SKU drift from option sort order", async () => {
        const dbWithSortRows = {
            select() {
                return {
                    from() {
                        return {
                            where: async () => [
                                {
                                    size: "Default",
                                    color: "Default",
                                    sizeSortOrder: 99,
                                    colorSortOrder: 99,
                                    isDefault: true,
                                },
                                {
                                    size: "2KG",
                                    color: "Red",
                                    sizeSortOrder: 2,
                                    colorSortOrder: 1,
                                    isDefault: false,
                                },
                            ],
                        };
                    },
                };
            },
        };

        await expect(getVariantSortOrder(dbWithSortRows as never, "prod_1")).resolves.toEqual({
            sizes: [{ value: "2KG", sortOrder: 2 }],
            colors: [{ value: "Red", sortOrder: 1 }],
        });
    });
});
