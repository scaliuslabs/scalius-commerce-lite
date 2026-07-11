import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, products, productVariants } from "@scalius/database/schema";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { checkAndAlertLowStock } from "../inventory/alerts";
import { applyVariantEditPlan, bulkCreateVariants } from "./products.variants";

vi.mock("../inventory/alerts", () => ({
    checkAndAlertLowStock: vi.fn().mockResolvedValue(null),
}));

const existingVariant = {
    id: "var_existing",
    productId: "prod_1",
    size: "M",
    color: null,
    weight: null,
    sku: "SKU-EXISTING",
    price: 100,
    stock: 4,
    reservedStock: 0,
    preorderStock: 0,
    isDefault: false,
    trackInventory: true,
    version: 2,
    stockVersion: 3,
    lowStockThreshold: 2,
    allowPreorder: false,
    preorderDate: null,
    preorderMessage: null,
    allowBackorder: false,
    backorderLimit: 0,
    taxClassId: null,
    taxClassificationVersion: 1,
    discountPercentage: 0,
    discountType: "percentage" as const,
    discountAmount: 0,
    barcode: null,
    barcodeType: null,
    colorSortOrder: 0,
    sizeSortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
};

const createDraft = {
    size: "L",
    color: null,
    weight: null,
    sku: "SKU-NEW",
    price: 120,
    stock: 7,
    trackInventory: true,
    barcode: null,
    barcodeType: null,
    discountType: "percentage" as const,
    discountPercentage: null,
    discountAmount: null,
};

function createAtomicDb(options: {
    batchError?: Error;
    currentVariants?: typeof existingVariant[];
    matchingSkuRows?: Array<{ id: string; sku: string }>;
} = {}) {
    let selectCount = 0;
    const batchCalls: unknown[][] = [];

    const db = {
        select() {
            selectCount += 1;
            return {
                from() {
                    return {
                        where() {
                            if (selectCount === 1) {
                                return { get: async () => ({ id: "prod_1" }) };
                            }
                            if (selectCount === 2) {
                                return Promise.resolve(options.currentVariants ?? [existingVariant]);
                            }
                            return Promise.resolve(options.matchingSkuRows ?? []);
                        },
                    };
                },
            };
        },
        insert(table: unknown) {
            if (table === productVariants) {
                return {
                    values(values: Record<string, unknown>) {
                        return {
                            returning() {
                                return { kind: "create", values };
                            },
                        };
                    },
                };
            }
            expect(table).toBe(inventoryMovements);
            return {
                select() {
                    return {
                        returning() {
                            return { kind: "movement" };
                        },
                    };
                },
            };
        },
        run() {
            return { kind: "guard" };
        },
        update(table: unknown) {
            expect([productVariants, products]).toContain(table);
            return {
                set(values: Record<string, unknown>) {
                    return {
                        where() {
                            return {
                                returning() {
                                    return {
                                        kind: table === products ? "revision" : "update",
                                        values,
                                    };
                                },
                            };
                        },
                    };
                },
            };
        },
        async batch(statements: Array<{ kind: string; values?: Record<string, unknown> }>) {
            batchCalls.push(statements);
            if (options.batchError) throw options.batchError;
            return statements.map((statement) => {
                if (statement.kind === "create") {
                    return [{
                        ...statement.values,
                        createdAt: new Date("2026-01-02T00:00:00.000Z"),
                        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
                        deletedAt: null,
                    }];
                }
                if (statement.kind === "update") {
                    return [{
                        ...existingVariant,
                        ...statement.values,
                        stock: 9,
                        version: 3,
                        stockVersion: 4,
                    }];
                }
                if (statement.kind === "movement") return [{ id: "movement_1" }];
                if (statement.kind === "revision") return [{ aggregateRevision: 2 }];
                return [{ ok: 1 }];
            });
        },
    };

    return { db, batchCalls, getSelectCount: () => selectCount };
}

describe("atomic product variant edit plans", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("rejects duplicate update IDs and normalized create SKUs before database work", async () => {
        const db = {
            select: vi.fn(() => {
                throw new Error("database should not be read");
            }),
        };

        await expect(applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [],
            updates: [
                { id: "var_1", price: 1 },
                { id: "var_1", stock: 2 },
            ],
        })).rejects.toBeInstanceOf(ValidationError);

        await expect(applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [
                createDraft,
                { ...createDraft, size: "XL", sku: "  sku-new " },
            ],
            updates: [],
        })).rejects.toBeInstanceOf(ValidationError);
        expect(db.select).not.toHaveBeenCalled();
    });

    it("commits mixed creates, stock movements, and CAS updates in one batch", async () => {
        const { db, batchCalls } = createAtomicDb();

        const result = await applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [createDraft],
            updates: [{ id: "var_existing", price: 130, stock: 9 }],
        }, "admin_1");

        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]).toHaveLength(8);
        expect(batchCalls[0]).toEqual([
            expect.objectContaining({ kind: "guard" }),
            expect.objectContaining({ kind: "guard" }),
            expect.objectContaining({ kind: "create" }),
            expect.objectContaining({ kind: "movement" }),
            expect.objectContaining({ kind: "update" }),
            expect.objectContaining({ kind: "movement" }),
            expect.objectContaining({ kind: "update" }),
            expect.objectContaining({ kind: "revision" }),
        ]);
        expect(result.created).toHaveLength(1);
        expect(result.created[0]?.id).toMatch(/^var_/);
        expect(result.updated).toEqual([
            expect.objectContaining({ id: "var_existing", stock: 9, version: 3, stockVersion: 4 }),
        ]);
        expect(result.aggregateRevision).toBe(2);
        expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, result.created[0]?.id);
        expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "var_existing");
    });

    it("routes bulk creates through the same initial-stock ledger transaction", async () => {
        const { db, batchCalls } = createAtomicDb({ currentVariants: [] });

        const result = await bulkCreateVariants(
            db as never,
            "prod_1",
            [createDraft],
            1,
        );

        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]?.map((statement) =>
            (statement as { kind?: string }).kind
        )).toEqual([
            "guard",
            "create",
            "movement",
            "update",
            "revision",
        ]);
        expect(result.variants).toEqual([
            expect.objectContaining({ stock: 9, stockVersion: 4 }),
        ]);
        expect(result.aggregateRevision).toBe(2);
    });

    it("surfaces a concurrent or unique conflict without reconciling any rows", async () => {
        const { db, batchCalls } = createAtomicDb({
            batchError: new Error("UNIQUE constraint failed: product_variants.sku"),
        });

        await expect(applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [createDraft],
            updates: [{ id: "var_existing", stock: 9 }],
        })).rejects.toBeInstanceOf(ConflictError);

        expect(batchCalls).toHaveLength(1);
        expect(checkAndAlertLowStock).not.toHaveBeenCalled();
    });

    it("rejects duplicate normalized option combinations before batching", async () => {
        const { db, batchCalls } = createAtomicDb();

        await expect(applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [{ ...createDraft, size: " m " }],
            updates: [],
        })).rejects.toBeInstanceOf(ValidationError);

        expect(batchCalls).toHaveLength(0);
    });

    it("allows two edited rows to swap SKUs without a false preflight conflict", async () => {
        const secondVariant = {
            ...existingVariant,
            id: "var_second",
            size: "L",
            sku: "SKU-SECOND",
        };
        const { db, batchCalls } = createAtomicDb({
            currentVariants: [existingVariant, secondVariant],
            matchingSkuRows: [
                { id: existingVariant.id, sku: existingVariant.sku },
                { id: secondVariant.id, sku: secondVariant.sku },
            ],
        });

        await expect(applyVariantEditPlan(db as never, "prod_1", {
            expectedAggregateRevision: 1,
            creates: [],
            updates: [
                { id: existingVariant.id, sku: secondVariant.sku },
                { id: secondVariant.id, sku: existingVariant.sku },
            ],
        })).resolves.toMatchObject({ created: [], updated: expect.any(Array) });

        expect(batchCalls).toHaveLength(1);
    });
});
