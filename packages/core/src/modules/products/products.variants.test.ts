import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { products } from "@scalius/database/schema";
import {
    assertUniqueChangedVariantOptions,
    bulkCreateVariants,
    bulkDeleteVariants,
    createVariant,
    deleteVariant,
    getVariantSortOrder,
    lookupByBarcode,
    normalizeVariantBarcode,
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
    expectedAggregateRevision: 1,
};

describe("product variant SKU rules", () => {
    it("normalizes case and whitespace when comparing option combinations", () => {
        expect(() =>
            assertUniqueChangedVariantOptions([
                { size: " Medium ", color: "RED" },
                { size: "medium", color: " red " },
            ]),
        ).toThrow(ValidationError);
    });

    it("rejects a changed option combination already used by an active sibling", () => {
        expect(() =>
            assertUniqueChangedVariantOptions(
                [{ size: "M", color: "Blue" }],
                [{ size: " m ", color: "BLUE" }],
            ),
        ).toThrow(ConflictError);
    });

    it("allows one changed SKU to repair a legacy duplicate incrementally", () => {
        expect(() =>
            assertUniqueChangedVariantOptions(
                [{ size: "L", color: "Blue" }],
                [
                    { size: "M", color: "Blue" },
                    { size: "M", color: "Blue" },
                ],
            ),
        ).not.toThrow();
    });

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
        }], 1)).rejects.toBeInstanceOf(ValidationError);
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
            deleteVariant(dbWithProtectedSku as never, "prod_1", "var_default", 1),
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
            bulkDeleteVariants(dbWithProtectedSku as never, "prod_1", ["var_default"], 1),
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
            deleteVariant(dbWithFinalOption as never, "prod_1", "var_option", 1),
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
            bulkDeleteVariants(dbWithFinalOption as never, "prod_1", ["var_option"], 1),
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
            deleteVariant(dbWithReservedSku as never, "prod_1", "var_reserved", 1),
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
            deleteVariant(dbWithOpenOrder as never, "prod_1", "var_open", 1),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(updateCalled).toBe(false);
        expect(deleteCalled).toBe(false);
    });

    it("soft-deletes a SKU with order item history instead of hard-deleting it", async () => {
        let selectCount = 0;
        let softDeleteValues: Record<string, unknown> | undefined;
        let hardDeleteCalled = false;
        const dbWithOrderHistory = {
            run() { return { kind: "guard" }; },
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
            update(table: unknown) {
                return {
                    set(values: Record<string, unknown>) {
                        if (table !== products) softDeleteValues = values;
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { kind: table === products ? "revision" : "soft-delete" };
                                    },
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
            batch: async (statements: Array<{ kind: string }>) =>
                statements.map((statement) =>
                    statement.kind === "revision"
                        ? [{ aggregateRevision: 2 }]
                        : statement.kind === "soft-delete"
                            ? [{ id: "var_ordered" }]
                            : [{ ok: 1 }]
                ),
        };

        await deleteVariant(dbWithOrderHistory as never, "prod_1", "var_ordered", 1);

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
            run() { return { kind: "guard" }; },
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
            update(table: unknown) {
                return {
                    set(values: Record<string, unknown>) {
                        if (table !== products) softDeleteValues = values;
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { kind: table === products ? "revision" : "soft-delete" };
                                    },
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
            batch: async (statements: Array<{ kind: string }>) =>
                statements.map((statement) =>
                    statement.kind === "revision"
                        ? [{ aggregateRevision: 2 }]
                        : statement.kind === "soft-delete"
                            ? [{ id: "var_moved" }]
                            : [{ ok: 1 }]
                ),
        };

        await deleteVariant(dbWithMovementHistory as never, "prod_1", "var_moved", 1);

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
            bulkDeleteVariants(dbWithReservedSku as never, "prod_1", ["var_reserved"], 1),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(batchCalled).toBe(false);
    });

    it("bulk delete soft-retires every SKU so audit identities are preserved", async () => {
        let selectCount = 0;
        const statements: unknown[] = [];
        const dbWithMixedHistory = {
            run() { return { kind: "guard" }; },
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
            update(table: unknown) {
                return {
                    set(values: Record<string, unknown>) {
                        return {
                            where() {
                                return {
                                    returning() {
                                        return {
                                            kind: table === products ? "revision" : "soft-delete",
                                            values,
                                        };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            batch: async (batchStatements: unknown[]) => {
                statements.push(...batchStatements);
                return batchStatements.map((statement) => {
                    const candidate = statement as { kind?: string };
                    if (candidate.kind === "soft-delete") {
                        return [
                            { id: "var_ordered" },
                            { id: "var_moved" },
                            { id: "var_unused" },
                        ];
                    }
                    if (candidate.kind === "revision") return [{ aggregateRevision: 2 }];
                    return [{ ok: 1 }];
                });
            },
        };

        await bulkDeleteVariants(
            dbWithMixedHistory as never,
            "prod_1",
            ["var_ordered", "var_moved", "var_unused"],
            1,
        );

        expect(statements.filter((statement) =>
            (statement as { kind?: string }).kind === "soft-delete"
        )).toEqual([
            expect.objectContaining({ kind: "soft-delete" }),
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
        ], 1)).rejects.toBeInstanceOf(ValidationError);
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
            run() { return { kind: "guard" }; },
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
            update(table: unknown) {
                return {
                    set(values: Record<string, unknown>) {
                        if (table !== products) updateValues = values;
                        return {
                            where() {
                                return {
                                    returning() {
                                        return {
                                            kind: table === products ? "revision" : "variant-update",
                                            values,
                                        };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            batch: async (statements: Array<{ kind: string; values?: Record<string, unknown> }>) =>
                statements.map((statement) => {
                    if (statement.kind === "revision") return [{ aggregateRevision: 2 }];
                    if (statement.kind === "variant-update") {
                        return [{ id: "var_default", ...statement.values }];
                    }
                    return [{ ok: 1 }];
                }),
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
                                            limit: async () => [variantRow],
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

    it("normalizes barcode writes and enforces barcode/type validity", () => {
        expect(normalizeVariantBarcode(" 4006381333931 ", "ean13")).toEqual({
            barcode: "4006381333931",
            barcodeType: "ean13",
        });
        expect(() => normalizeVariantBarcode("123", null)).toThrow(ValidationError);
        expect(() => normalizeVariantBarcode("123", "ean13")).toThrow(ValidationError);
    });

    it("fails closed when a normalized barcode has multiple SKU matches", async () => {
        const dbWithDuplicates = {
            select() {
                return {
                    from() {
                        return {
                            innerJoin() {
                                return {
                                    where() {
                                        return { limit: async () => [{}, {}] };
                                    },
                                };
                            },
                        };
                    },
                };
            },
        };
        await expect(
            lookupByBarcode(dbWithDuplicates as never, " ABC "),
        ).rejects.toBeInstanceOf(ConflictError);
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
