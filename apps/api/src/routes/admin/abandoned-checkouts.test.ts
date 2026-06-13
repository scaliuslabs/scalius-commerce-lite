import { beforeEach, describe, expect, it, vi } from "vitest";

import { abandonedCheckouts, OrderStatus, orders } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
    applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("@scalius/core/modules/inventory", () => ({
    applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { archiveStaleIncompleteOrders } from "./system-utils";

type Operation = {
    op: string;
    table?: unknown;
    values?: Record<string, unknown>;
    orderId?: string;
    status?: string;
};

type StaleOrder = {
    id: string;
    customerPhone: string | null;
    inventoryAction: string;
    createdAt: number;
    updatedAt: number;
};

function staleOrder(overrides: Partial<StaleOrder> = {}): StaleOrder {
    return {
        id: overrides.id ?? "order_1",
        customerPhone: overrides.customerPhone ?? "+8801712345678",
        inventoryAction: overrides.inventoryAction ?? "reserved",
        createdAt: overrides.createdAt ?? 1_764_977_200,
        updatedAt: overrides.updatedAt ?? 1_764_977_200,
    };
}

function createDbMock(staleOrders: StaleOrder[]) {
    const operations: Operation[] = [];

    const db = {
        select: vi.fn(() => ({
            from(table: unknown) {
                operations.push({ op: "select.from", table });
                return {
                    where: async () => staleOrders,
                };
            },
        })),
        insert: vi.fn((table: unknown) => {
            operations.push({ op: "insert", table });
            return {
                values(values: Record<string, unknown>) {
                    operations.push({ op: "insert.values", table, values });
                    return {
                        onConflictDoNothing: async () => {
                            operations.push({ op: "insert.onConflictDoNothing", table });
                        },
                    };
                },
            };
        }),
        update: vi.fn((table: unknown) => {
            operations.push({ op: "update", table });
            return {
                set(values: Record<string, unknown>) {
                    operations.push({ op: "update.set", table, values });
                    return {
                        where: async () => {
                            operations.push({ op: "update.where", table });
                        },
                    };
                },
            };
        }),
        delete: vi.fn(() => {
            throw new Error("orders must not be hard-deleted by abandoned checkout cleanup");
        }),
    };

    return { db: db as unknown as Database, operations, rawDb: db };
}

describe("archiveStaleIncompleteOrders", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("releases reserved inventory before archiving and soft-deleting stale incomplete orders", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder()]);
        mocks.applyInventoryForStatusChange.mockImplementation(async (_db, orderId: string, status: string) => {
            operations.push({ op: "inventory.release", orderId, status });
            return "restored";
        });

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toEqual({ archived: 1, failed: 0, errors: [] });
        expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.CANCELLED);
        expect(rawDb.delete).not.toHaveBeenCalled();

        const releaseIndex = operations.findIndex((entry) => entry.op === "inventory.release");
        const insertIndex = operations.findIndex((entry) => entry.op === "insert.values");
        const updateIndex = operations.findIndex((entry) => entry.op === "update.set");

        expect(releaseIndex).toBeGreaterThanOrEqual(0);
        expect(releaseIndex).toBeLessThan(insertIndex);
        expect(insertIndex).toBeLessThan(updateIndex);
        expect(operations[insertIndex]).toMatchObject({
            table: abandonedCheckouts,
            values: {
                id: "ab_ch_sys_order_1",
                checkoutId: "order_1",
                customerPhone: "+8801712345678",
            },
        });
        expect(operations[updateIndex]).toMatchObject({
            table: orders,
            values: {
                status: OrderStatus.CANCELLED,
                inventoryAction: "restored",
            },
        });
    });

    it("does not archive or delete an order when inventory release fails", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder()]);
        mocks.applyInventoryForStatusChange.mockRejectedValue(new Error("release failed"));

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toEqual({
            archived: 0,
            failed: 1,
            errors: [{ orderId: "order_1", error: "release failed" }],
        });
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op.startsWith("insert"))).toBe(false);
        expect(operations.some((entry) => entry.op.startsWith("update"))).toBe(false);
    });

    it("archives empty-inventory orders without calling the inventory transition helper", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder({ inventoryAction: "none" })]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toEqual({ archived: 1, failed: 0, errors: [] });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op === "insert.values")).toBe(true);
        expect(operations.some((entry) => entry.op === "update.set")).toBe(true);
    });
});
