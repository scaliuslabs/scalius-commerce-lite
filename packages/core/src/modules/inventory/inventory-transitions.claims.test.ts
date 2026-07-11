import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { applyClaimedInventoryEntryBatch } from "./inventory-transitions";

const alertMocks = vi.hoisted(() => ({
    checkAndAlertLowStock: vi.fn(async () => undefined),
}));

vi.mock("./alerts", () => ({
    checkAndAlertLowStock: alertMocks.checkAndAlertLowStock,
}));

async function claimedMovementId(input: {
    claimKey: string;
    orderId: string;
    variantId: string;
    operation: "deduct" | "restore";
    pool: "regular" | "preorder" | "backorder";
    generation?: number;
}): Promise<string> {
    const payload = [
        "order-inventory-entry:v1",
        input.claimKey,
        input.orderId,
        input.variantId,
        input.operation,
        input.pool,
        String(input.generation ?? 0),
    ].join("\0");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `transition:${hex}`;
}

function createClaimBatchDb(options: {
    batchError?: Error;
    existingMovements?: Array<{
        id: string;
        variantId: string;
        orderId: string | null;
        type: string;
        quantity: number;
    }>;
    insertResult?: Array<{ id: string }>;
    updateResult?: Array<{ id: string }>;
} = {}) {
    const batchCalls: Array<Array<{ kind?: string; table?: unknown }>> = [];
    const db = {
        select(projection: Record<string, unknown>) {
            return {
                from() {
                    return {
                        where() {
                            return {
                                get: async () => {
                                    if ("stockVersion" in projection) {
                                        return {
                                            id: "var_a",
                                            stock: 10,
                                            reservedStock: 2,
                                            preorderStock: 4,
                                            stockVersion: 7,
                                        };
                                    }
                                    if ("count" in projection) return { count: 0 };
                                    return null;
                                },
                                all: async () => options.existingMovements ?? [],
                            };
                        },
                    };
                },
            };
        },
        insert(table: unknown) {
            return {
                select() {
                    return {
                        returning() {
                            return { kind: "movement", table };
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
                                    return { kind: "variant", table, values };
                                },
                            };
                        },
                    };
                },
            };
        },
        delete(table: unknown) {
            return {
                where() {
                    return {
                        returning() {
                            return { kind: "delete", table };
                        },
                    };
                },
            };
        },
        batch: async (statements: Array<{ kind?: string; table?: unknown }>) => {
            batchCalls.push(statements);
            if (options.batchError) throw options.batchError;
            return statements.map((statement) => {
                if (statement.kind === "movement") return options.insertResult ?? [{ id: "movement_1" }];
                if (statement.kind === "variant") return options.updateResult ?? [{ id: "var_a" }];
                return [];
            });
        },
    };

    return { db: db as unknown as Database, batchCalls };
}

describe("applyClaimedInventoryEntryBatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("commits the deterministic movement claim and stock CAS in one batch", async () => {
        const { db, batchCalls } = createClaimBatchDb();

        await applyClaimedInventoryEntryBatch(db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "regular" }],
            claimKey: "admin-edit:v4:deduct-added",
            pool: "regular",
        });

        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]).toEqual([
            expect.objectContaining({ kind: "movement", table: inventoryMovements }),
            expect.objectContaining({ kind: "variant", table: productVariants }),
        ]);
        expect(alertMocks.checkAndAlertLowStock).toHaveBeenCalledWith(db, "var_a");
    });

    it("treats an exact duplicate claim as replay success without a second counter write", async () => {
        const claimKey = "admin-edit:v4:deduct-added";
        const id = await claimedMovementId({
            claimKey,
            orderId: "order_1",
            variantId: "var_a",
            operation: "deduct",
            pool: "regular",
        });
        const { db, batchCalls } = createClaimBatchDb({
            batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id transition:claim"),
            existingMovements: [{
                id,
                variantId: "var_a",
                orderId: "order_1",
                type: "deducted",
                quantity: 2,
            }],
        });

        await expect(applyClaimedInventoryEntryBatch(db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "regular" }],
            claimKey,
            pool: "regular",
        })).resolves.toBeUndefined();

        expect(batchCalls).toHaveLength(1);
        expect(alertMocks.checkAndAlertLowStock).toHaveBeenCalledOnce();
    });

    it("keeps preorder deduction and restoration in the preorder pool", async () => {
        const deducted = createClaimBatchDb();
        await applyClaimedInventoryEntryBatch(deducted.db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "preorder" }],
            claimKey: "admin-edit:v4:deduct-preorder",
            pool: "preorder",
        });
        const deductUpdate = deducted.batchCalls[0]?.[1] as { values?: Record<string, unknown> };
        expect(deductUpdate.values).toHaveProperty("reservedStock");
        expect(deductUpdate.values).not.toHaveProperty("stock");
        expect(deductUpdate.values).not.toHaveProperty("preorderStock");

        const restored = createClaimBatchDb();
        await applyClaimedInventoryEntryBatch(restored.db, {
            orderId: "order_1",
            operation: "restore",
            entries: [{ variantId: "var_a", quantity: 2, pool: "preorder" }],
            claimKey: "admin-edit:v4:restore-preorder",
            pool: "preorder",
        });
        const restoreUpdate = restored.batchCalls[0]?.[1] as { values?: Record<string, unknown> };
        expect(restoreUpdate.values).toHaveProperty("preorderStock");
        expect(restoreUpdate.values).not.toHaveProperty("stock");
        expect(restoreUpdate.values).not.toHaveProperty("reservedStock");
    });

    it("fails after bounded retries when the stock CAS claim cannot commit", async () => {
        const { db, batchCalls } = createClaimBatchDb({
            insertResult: [],
            updateResult: [],
        });

        await expect(applyClaimedInventoryEntryBatch(db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "regular" }],
            claimKey: "admin-edit:v4:deduct-conflict",
            pool: "regular",
        })).rejects.toThrow("after 3 retries due to concurrent modifications");

        expect(batchCalls).toHaveLength(3);
        expect(alertMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
    });

    it("fails for manual reconciliation when a partial-batch rollback cannot be proven", async () => {
        const { db, batchCalls } = createClaimBatchDb({
            updateResult: [],
        });

        await expect(applyClaimedInventoryEntryBatch(db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "regular" }],
            claimKey: "admin-edit:v4:deduct-rollback-conflict",
            pool: "regular",
        })).rejects.toThrow("manual reconciliation is required");

        expect(batchCalls).toHaveLength(2);
        expect(alertMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
    });

    it("fails closed when a replayed claim key has a different quantity", async () => {
        const claimKey = "admin-edit:v4:deduct-added";
        const id = await claimedMovementId({
            claimKey,
            orderId: "order_1",
            variantId: "var_a",
            operation: "deduct",
            pool: "regular",
        });
        const { db } = createClaimBatchDb({
            batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id transition:claim"),
            existingMovements: [{
                id,
                variantId: "var_a",
                orderId: "order_1",
                type: "deducted",
                quantity: 1,
            }],
        });

        await expect(applyClaimedInventoryEntryBatch(db, {
            orderId: "order_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 2, pool: "regular" }],
            claimKey,
            pool: "regular",
        })).rejects.toThrow("claim mismatch requires manual inventory reconciliation");

        expect(alertMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
    });
});
