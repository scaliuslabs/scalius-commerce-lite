import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
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
                            where: async () => [{ id: "var_default", isDefault: true, reservedStock: 0 }],
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
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            get: async () => ({ count: 0 }),
                                        };
                                    },
                                };
                            },
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return { id: "var_option", isDefault: false };
                                        }
                                        if (selectCount === 3) {
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
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            groupBy: async () => [],
                                        };
                                    },
                                };
                            },
                            where() {
                                if (selectCount === 1) {
                                    return Promise.resolve([
                                        { id: "var_option", isDefault: false, reservedStock: 0 },
                                    ]);
                                }

                                return {
                                    get: async () => {
                                        if (selectCount === 3) return { isActive: true };
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

    it("rejects deleting a SKU with active reserved stock", async () => {
        let updateCalled = false;
        let deleteCalled = false;
        const dbWithReservedSku = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => ({
                                        id: "var_reserved",
                                        isDefault: false,
                                        reservedStock: 2,
                                    }),
                                };
                            },
                        };
                    },
                };
            },
            update() {
                updateCalled = true;
                return {};
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            deleteVariant(dbWithReservedSku as never, "prod_1", "var_reserved"),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(updateCalled).toBe(false);
        expect(deleteCalled).toBe(false);
    });

    it("rejects deleting a SKU while a non-terminal order still references it", async () => {
        let updateCalled = false;
        let deleteCalled = false;
        const dbWithOpenOrder = {
            select() {
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            get: async () => ({ count: 1 }),
                                        };
                                    },
                                };
                            },
                            where() {
                                return {
                                    get: async () => ({ id: "var_open", isDefault: false, reservedStock: 0 }),
                                };
                            },
                        };
                    },
                };
            },
            update() {
                updateCalled = true;
                return {};
            },
            delete() {
                deleteCalled = true;
                return {};
            },
        };

        await expect(
            deleteVariant(dbWithOpenOrder as never, "prod_1", "var_open"),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(updateCalled).toBe(false);
        expect(deleteCalled).toBe(false);
    });

    it("soft-deletes a SKU with order item history instead of hard-deleting it", async () => {
        let selectCount = 0;
        let softDeleteValues: Record<string, unknown> | undefined;
        let hardDeleteCalled = false;
        const dbWithOrderHistory = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            get: async () => ({ count: 0 }),
                                        };
                                    },
                                };
                            },
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return { id: "var_ordered", isDefault: false, reservedStock: 0 };
                                        }
                                        if (selectCount === 3) return { isActive: false };
                                        if (selectCount === 4) return { count: 0 };
                                        return { count: 1 };
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
                        softDeleteValues = values;
                        return {
                            where() {
                                return {
                                    returning: async () => [{ id: "var_ordered" }],
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                hardDeleteCalled = true;
                return {};
            },
        };

        await deleteVariant(dbWithOrderHistory as never, "prod_1", "var_ordered");

        expect(softDeleteValues).toMatchObject({
            deletedAt: expect.anything(),
            updatedAt: expect.anything(),
        });
        expect(hardDeleteCalled).toBe(false);
    });

    it("soft-deletes a SKU with inventory movement history instead of hard-deleting it", async () => {
        let selectCount = 0;
        let softDeleteValues: Record<string, unknown> | undefined;
        let hardDeleteCalled = false;
        const dbWithMovementHistory = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            get: async () => ({ count: 0 }),
                                        };
                                    },
                                };
                            },
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return { id: "var_moved", isDefault: false, reservedStock: 0 };
                                        }
                                        if (selectCount === 3) return { isActive: false };
                                        if (selectCount === 4) return { count: 0 };
                                        if (selectCount === 5) return { count: 0 };
                                        return { count: 1 };
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
                        softDeleteValues = values;
                        return {
                            where() {
                                return {
                                    returning: async () => [{ id: "var_moved" }],
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                hardDeleteCalled = true;
                return {};
            },
        };

        await deleteVariant(dbWithMovementHistory as never, "prod_1", "var_moved");

        expect(softDeleteValues).toMatchObject({
            deletedAt: expect.anything(),
            updatedAt: expect.anything(),
        });
        expect(hardDeleteCalled).toBe(false);
    });

    it("bulk delete rejects SKUs with active reserved stock", async () => {
        let batchCalled = false;
        const dbWithReservedSku = {
            select() {
                return {
                    from() {
                        return {
                            where: async () => [
                                { id: "var_reserved", isDefault: false, reservedStock: 1 },
                            ],
                        };
                    },
                };
            },
            batch: async () => {
                batchCalled = true;
                return [];
            },
        };

        await expect(
            bulkDeleteVariants(dbWithReservedSku as never, "prod_1", ["var_reserved"]),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(batchCalled).toBe(false);
    });

    it("bulk delete soft-deletes history-backed SKUs and hard-deletes only unused SKUs", async () => {
        let selectCount = 0;
        const statements: unknown[] = [];
        const dbWithMixedHistory = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return {
                                            groupBy: async () => [],
                                        };
                                    },
                                };
                            },
                            where() {
                                if (selectCount === 1) {
                                    return Promise.resolve([
                                        { id: "var_ordered", isDefault: false, reservedStock: 0 },
                                        { id: "var_moved", isDefault: false, reservedStock: 0 },
                                        { id: "var_unused", isDefault: false, reservedStock: 0 },
                                    ]);
                                }
                                if (selectCount === 5) {
                                    return {
                                        groupBy: async () => [{ variantId: "var_ordered" }],
                                    };
                                }
                                if (selectCount === 6) {
                                    return {
                                        groupBy: async () => [{ variantId: "var_moved" }],
                                    };
                                }

                                return {
                                    get: async () => {
                                        if (selectCount === 3) return { isActive: false };
                                        return { count: 0 };
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
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { kind: "soft-delete", values };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                return {
                    where() {
                        return {
                            returning() {
                                return { kind: "hard-delete" };
                            },
                        };
                    },
                };
            },
            batch: async (batchStatements: unknown[]) => {
                statements.push(...batchStatements);
                return [[{ id: "var_ordered" }, { id: "var_moved" }], [{ id: "var_unused" }]];
            },
        };

        await bulkDeleteVariants(
            dbWithMixedHistory as never,
            "prod_1",
            ["var_ordered", "var_moved", "var_unused"],
        );

        expect(statements).toEqual([
            expect.objectContaining({ kind: "soft-delete" }),
            expect.objectContaining({ kind: "hard-delete" }),
        ]);
    });

    it("rejects creating a SKU that mixes option axes with existing SKUs", async () => {
        let insertCalled = false;
        const dbWithSizeOnlySku = {
            select() {
                return {
                    from() {
                        return {
                            where: async () => [
                                { id: "var_size", size: "M", color: null },
                            ],
                        };
                    },
                };
            },
            insert() {
                insertCalled = true;
                return {};
            },
        };

        await expect(createVariant(dbWithSizeOnlySku as never, "prod_1", {
            ...baseVariant,
            size: null,
            color: "Red",
        })).rejects.toBeInstanceOf(ValidationError);
        expect(insertCalled).toBe(false);
    });

    it("rejects bulk-created SKUs with mixed option axes before reading the database", async () => {
        const dbShouldNotBeRead = {
            select() {
                throw new Error("unexpected database read");
            },
        };

        await expect(bulkCreateVariants(dbShouldNotBeRead as never, "prod_1", [
            { ...baseVariant, sku: "SKU-1", size: "M", color: null },
            { ...baseVariant, sku: "SKU-2", size: null, color: "Red" },
        ])).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects variant updates that would mix option axes with sibling SKUs", async () => {
        let selectCount = 0;
        let updateCalled = false;
        const dbWithSiblingSizeSku = {
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                if (selectCount === 2) {
                                    return Promise.resolve([
                                        { id: "var_size", size: "M", color: null },
                                    ]);
                                }

                                return {
                                    get: async () => ({
                                        id: "var_color",
                                        isDefault: false,
                                        size: null,
                                        color: "Blue",
                                        stock: 5,
                                        stockVersion: 1,
                                        trackInventory: true,
                                    }),
                                };
                            },
                        };
                    },
                };
            },
            update() {
                updateCalled = true;
                return {};
            },
        };

        await expect(updateVariant(dbWithSiblingSizeSku as never, "prod_1", "var_color", {
            ...baseVariant,
            size: "L",
            color: "Blue",
        })).rejects.toBeInstanceOf(ValidationError);
        expect(updateCalled).toBe(false);
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
