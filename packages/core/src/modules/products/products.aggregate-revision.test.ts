import { describe, expect, it, vi } from "vitest";
import { products } from "@scalius/database/schema";
import {
    executeProductAggregateMutationBatch,
    ProductRevisionConflictError,
    ProductStateConflictError,
} from "./products.aggregate-revision";

function createDb(options: {
    stale?: boolean;
    currentRevision?: number;
    deletedAt?: number | null;
} = {}) {
    const batch = vi.fn(async (statements: Array<{ kind: string }>) => {
        if (options.stale) throw new Error("malformed JSON");
        return statements.map((statement) => {
            if (statement.kind === "mutation") return [{ id: "changed" }];
            if (statement.kind === "revision") {
                return [{ aggregateRevision: (options.currentRevision ?? 4) + 1 }];
            }
            return [{ ok: 1 }];
        });
    });
    const db = {
        run: vi.fn(() => ({ kind: "guard" })),
        update(table: unknown) {
            expect(table).toBe(products);
            return {
                set() {
                    return {
                        where() {
                            return {
                                returning() {
                                    return { kind: "revision" };
                                },
                            };
                        },
                    };
                },
            };
        },
        select() {
            return {
                from() {
                    return {
                        kind: "guard",
                        where() {
                            return {
                                get: async () => ({
                                    aggregateRevision: options.currentRevision ?? 4,
                                    deletedAt: options.deletedAt ?? null,
                                }),
                            };
                        },
                    };
                },
            };
        },
        batch,
    };
    return { db, batch };
}

describe("product aggregate revision batches", () => {
    it("guards, mutates, and increments exactly once in one batch", async () => {
        const { db, batch } = createDb({ currentRevision: 4 });

        const result = await executeProductAggregateMutationBatch(
            db as never,
            "prod_1",
            4,
            [{ kind: "mutation" } as never],
        );

        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0]?.[0].map((statement) => statement.kind)).toEqual([
            "guard",
            "mutation",
            "revision",
        ]);
        expect(result).toEqual({
            mutationResults: [[{ id: "changed" }]],
            aggregateRevision: 5,
        });
    });

    it("returns a distinct conflict with authoritative revision details", async () => {
        const { db } = createDb({ stale: true, currentRevision: 7 });

        const error = await executeProductAggregateMutationBatch(
            db as never,
            "prod_1",
            4,
            [{ kind: "mutation" } as never],
        ).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(ProductRevisionConflictError);
        expect(error).toMatchObject({
            status: 409,
            code: "PRODUCT_REVISION_CONFLICT",
            details: { expectedRevision: 4, currentRevision: 7 },
        });
    });

    it("does not relabel an inner mutation guard failure when the product revision still matches", async () => {
        const { db } = createDb({ stale: true, currentRevision: 4 });

        const error = await executeProductAggregateMutationBatch(
            db as never,
            "prod_1",
            4,
            [{ kind: "mutation" } as never],
        ).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ProductRevisionConflictError);
        expect((error as Error).message).toContain("malformed JSON");
    });

    it("rejects active-editor mutations against a trashed product", async () => {
        const { db } = createDb({
            stale: true,
            currentRevision: 4,
            deletedAt: 1_700_000_000,
        });

        await expect(executeProductAggregateMutationBatch(
            db as never,
            "prod_1",
            4,
            [{ kind: "mutation" } as never],
        )).rejects.toBeInstanceOf(ProductStateConflictError);
    });

    it("rejects restore and hard-delete mutations against a live product", async () => {
        const { db } = createDb({ stale: true, currentRevision: 4 });

        await expect(executeProductAggregateMutationBatch(
            db as never,
            "prod_1",
            4,
            [{ kind: "mutation" } as never],
            "trashed",
        )).rejects.toBeInstanceOf(ProductStateConflictError);
    });
});
