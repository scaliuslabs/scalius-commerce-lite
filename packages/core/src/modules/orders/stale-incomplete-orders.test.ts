import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    abandonedCheckouts,
    orders,
    PaymentMethod,
    paymentPlans,
    PaymentPlanStatus,
    PaymentStatus,
    OrderStatus,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
    applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../inventory", () => ({
    applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { archiveStaleIncompleteOrders } from "./stale-incomplete-orders";

type Operation = {
    op: string;
    table?: unknown;
    values?: Record<string, unknown>;
    orderId?: string;
    status?: string;
};

type ReturningRows = Array<{ id: string }>;

type MockStatement =
    | {
        kind: "update";
        table: unknown;
        values: Record<string, unknown>;
    }
    | {
        kind: "update-returning";
        table: unknown;
        values: Record<string, unknown>;
        then<TResult1 = ReturningRows, TResult2 = never>(
            onfulfilled?: ((value: ReturningRows) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2>;
    };

type StaleOrder = {
    id: string;
    customerPhone: string | null;
    inventoryAction: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    paidAmount: number;
    deletedAt: number | null;
    version: number;
    shipmentClaimId: string | null;
    shipmentClaimExpiresAt: number | null;
    createdAt: number;
    updatedAt: number;
};

function staleOrder(overrides: Partial<StaleOrder> = {}): StaleOrder {
    return {
        id: overrides.id ?? "order_1",
        customerPhone: overrides.customerPhone ?? "+8801712345678",
        inventoryAction: overrides.inventoryAction ?? "reserved",
        status: overrides.status ?? OrderStatus.INCOMPLETE,
        paymentMethod: overrides.paymentMethod ?? PaymentMethod.STRIPE,
        paymentStatus: overrides.paymentStatus ?? PaymentStatus.UNPAID,
        paidAmount: overrides.paidAmount ?? 0,
        deletedAt: overrides.deletedAt ?? null,
        version: overrides.version ?? 7,
        shipmentClaimId: overrides.shipmentClaimId ?? null,
        shipmentClaimExpiresAt: overrides.shipmentClaimExpiresAt ?? null,
        createdAt: overrides.createdAt ?? 1_764_977_200,
        updatedAt: overrides.updatedAt ?? 1_764_977_200,
    };
}

function createDbMock(staleOrders: StaleOrder[]) {
    const operations: Operation[] = [];
    const updateResults: Array<ReturningRows> = [];

    const makeReturningStatement = (
        table: unknown,
        values: Record<string, unknown>,
    ): MockStatement => ({
        kind: "update-returning",
        table,
        values,
        then<TResult1 = ReturningRows, TResult2 = never>(
            onfulfilled?: ((value: ReturningRows) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
            return Promise.resolve(updateResults.shift() ?? [{ id: "order_1" }])
                .then(onfulfilled, onrejected);
        },
    });

    const db = {
        select: vi.fn(() => ({
            from(table: unknown) {
                operations.push({ op: "select.from", table });
                return {
                    where: () => ({
                        limit: async (limit: number) => staleOrders.slice(0, limit),
                    }),
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
                        where: () => {
                            operations.push({ op: "update.where", table });
                            const statement: MockStatement = { kind: "update", table, values };
                            return {
                                ...statement,
                                returning: () => makeReturningStatement(table, values),
                            };
                        },
                    };
                },
            };
        }),
        delete: vi.fn(() => {
            throw new Error("orders must not be hard-deleted by stale incomplete cleanup");
        }),
        batch: vi.fn(async (statements: MockStatement[]) => {
            operations.push({ op: "batch", values: { count: statements.length } });
            return statements.map((statement) => {
                if (statement.kind === "update-returning") {
                    return updateResults.shift() ?? [{ id: "order_1" }];
                }
                return [];
            });
        }),
    };

    return { db: db as unknown as Database, operations, rawDb: db, updateResults };
}

describe("archiveStaleIncompleteOrders", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("releases reserved inventory before archiving and soft-deleting stale unpaid incomplete orders", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder()]);
        mocks.applyInventoryForStatusChange.mockImplementation(async (_db, orderId: string, status: string) => {
            operations.push({ op: "inventory.release", orderId, status });
            return "restored";
        });

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({
            found: 1,
            limit: 25,
            hasMore: false,
            archived: 1,
            failed: 0,
            archivedOrderIds: ["order_1"],
            errors: [],
        });
        expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.CANCELLED);
        expect(rawDb.delete).not.toHaveBeenCalled();

        const claimIndex = operations.findIndex((entry) =>
            entry.op === "update.set" && entry.values?.status === OrderStatus.CANCELLED
        );
        const releaseIndex = operations.findIndex((entry) => entry.op === "inventory.release");
        const insertIndex = operations.findIndex((entry) => entry.op === "insert.values");
        const finalizeIndex = operations.findIndex((entry) =>
            entry.op === "update.set" && entry.values?.deletedAt !== undefined
        );

        expect(claimIndex).toBeGreaterThanOrEqual(0);
        expect(releaseIndex).toBeGreaterThanOrEqual(0);
        expect(claimIndex).toBeLessThan(releaseIndex);
        expect(releaseIndex).toBeLessThan(finalizeIndex);
        expect(finalizeIndex).toBeLessThan(insertIndex);
        expect(operations[insertIndex]).toMatchObject({
            table: abandonedCheckouts,
            values: {
                id: "ab_ch_sys_order_1",
                checkoutId: "order_1",
                customerPhone: "+8801712345678",
            },
        });
        expect(operations[claimIndex]).toMatchObject({
            table: orders,
            values: {
                status: OrderStatus.CANCELLED,
            },
        });
        expect(operations[finalizeIndex]).toMatchObject({
            table: orders,
            values: {
                inventoryAction: "restored",
            },
        });
        expect(operations.some((entry) =>
            entry.op === "update.set" &&
            entry.table === paymentPlans &&
            entry.values?.status === PaymentPlanStatus.CANCELLED
        )).toBe(true);
    });

    it("archives failed hosted-payment orders after the stale cutoff", async () => {
        const { db } = createDbMock([
            staleOrder({
                id: "failed_order",
                paymentStatus: PaymentStatus.FAILED,
            }),
        ]);
        mocks.applyInventoryForStatusChange.mockResolvedValue("restored");

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({
            archived: 1,
            failed: 0,
            archivedOrderIds: ["failed_order"],
        });
        expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "failed_order", OrderStatus.CANCELLED);
    });

    it("bounds each sweep and reports when more candidates remain", async () => {
        const { db } = createDbMock([
            staleOrder({ id: "order_1", inventoryAction: "none" }),
            staleOrder({ id: "order_2", inventoryAction: "none" }),
            staleOrder({ id: "order_3", inventoryAction: "none" }),
        ]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000, { limit: 2 });

        expect(result).toMatchObject({
            found: 2,
            limit: 2,
            hasMore: true,
            archived: 2,
            archivedOrderIds: ["order_1", "order_2"],
        });
    });

    it("does not archive or delete an order when inventory release fails", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder()]);
        mocks.applyInventoryForStatusChange.mockRejectedValue(new Error("release failed"));

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({
            archived: 0,
            failed: 1,
            archivedOrderIds: [],
            errors: [{ orderId: "order_1", error: "release failed" }],
        });
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op.startsWith("insert"))).toBe(false);
        expect(operations.some((entry) =>
            entry.op === "update.set" && entry.values?.status === OrderStatus.CANCELLED
        )).toBe(true);
        expect(operations.some((entry) =>
            entry.op === "update.set" && entry.values?.status === OrderStatus.INCOMPLETE
        )).toBe(true);
        expect(operations.some((entry) =>
            entry.op === "update.set" && entry.values?.deletedAt !== undefined
        )).toBe(false);
    });

    it("archives empty-inventory orders without calling the inventory transition helper", async () => {
        const { db, rawDb, operations } = createDbMock([staleOrder({ inventoryAction: "none" })]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({ archived: 1, failed: 0, errors: [] });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op === "insert.values")).toBe(true);
        expect(operations.some((entry) => entry.op === "update.set")).toBe(true);
    });

    it("skips stale orders when the cleanup claim loses to a concurrent payment update", async () => {
        const { db, rawDb, operations, updateResults } = createDbMock([staleOrder()]);
        updateResults.push([]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({ archived: 0, failed: 0, errors: [] });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op.startsWith("insert"))).toBe(false);
        expect(operations.filter((entry) => entry.op === "update.set")).toHaveLength(1);
    });

    it("does not create an abandoned checkout archive when final soft-delete loses its guard", async () => {
        const { db, rawDb, operations, updateResults } = createDbMock([staleOrder({ inventoryAction: "none" })]);
        updateResults.push([{ id: "order_1" }], []);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({
            archived: 0,
            failed: 1,
            archivedOrderIds: [],
            errors: [{ orderId: "order_1", error: "Stale order cleanup changed concurrently before final archive" }],
        });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(rawDb.delete).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op.startsWith("insert"))).toBe(false);
    });

    it("skips active shipment claims even if a stale row is returned by a stale query plan", async () => {
        const { db, operations } = createDbMock([
            staleOrder({
                shipmentClaimId: "ship_claim_active",
                shipmentClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
            }),
        ]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({ found: 1, archived: 0, failed: 0 });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op === "update.set")).toBe(false);
    });

    it("skips non-recoverable payment states returned by a stale query plan", async () => {
        const { db, operations } = createDbMock([
            staleOrder({
                paymentStatus: PaymentStatus.PARTIAL,
                paidAmount: 100,
            }),
        ]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({ found: 1, archived: 0, failed: 0 });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op === "update.set")).toBe(false);
    });

    it("skips COD orders returned by a stale query plan", async () => {
        const { db, operations } = createDbMock([
            staleOrder({
                paymentMethod: PaymentMethod.COD,
            }),
        ]);

        const result = await archiveStaleIncompleteOrders(db, 1_765_000_000);

        expect(result).toMatchObject({ found: 1, archived: 0, failed: 0 });
        expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(operations.some((entry) => entry.op === "update.set")).toBe(false);
    });

});
