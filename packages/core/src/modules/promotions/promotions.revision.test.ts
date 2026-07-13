import { describe, expect, it, vi } from "vitest";

import { promotions } from "@scalius/database/schema";
import {
    executePromotionRuleMutationBatch,
    PromotionRevisionConflictError,
    PromotionStateConflictError,
} from "./promotions.revision";

function createDb(options: {
    stale?: boolean;
    currentRevision?: number;
    status?: "draft" | "active" | "paused" | "archived";
    deletedAt?: Date | null;
} = {}) {
    const batch = vi.fn(async (statements: Array<{ kind: string }>) => {
        if (options.stale) throw new Error("malformed JSON");
        return statements.map((statement) => statement.kind === "revision"
            ? [{ revision: (options.currentRevision ?? 4) + 1 }]
            : [{ ok: 1 }]);
    });
    const db = {
        select() {
            const chain: Record<string, unknown> = { kind: "guard" };
            chain.from = vi.fn(() => chain);
            chain.where = vi.fn(() => ({
                get: async () => ({
                    revision: options.currentRevision ?? 4,
                    status: options.status ?? "draft",
                    deletedAt: options.deletedAt ?? null,
                }),
            }));
            return chain;
        },
        update(table: unknown) {
            expect(table).toBe(promotions);
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
        batch,
    };
    return { db, batch };
}

describe("promotion aggregate revision batches", () => {
    it("guards every child mutation and advances the parent exactly once", async () => {
        const { db, batch } = createDb({ currentRevision: 4 });
        const result = await executePromotionRuleMutationBatch(
            db as never,
            "promo_1",
            4,
            [{ kind: "retire-effects" } as never, { kind: "insert-codes" } as never],
        );

        expect(batch.mock.calls[0]?.[0].map((statement) => statement.kind)).toEqual([
            "guard",
            "retire-effects",
            "insert-codes",
            "revision",
        ]);
        expect(result.revision).toBe(5);
    });

    it("returns current revision details for a stale editor", async () => {
        const { db } = createDb({ stale: true, currentRevision: 8 });
        await expect(executePromotionRuleMutationBatch(
            db as never,
            "promo_1",
            4,
            [{ kind: "parent" } as never],
        )).rejects.toMatchObject({
            code: "PROMOTION_REVISION_CONFLICT",
            details: {
                promotionId: "promo_1",
                expectedRevision: 4,
                currentRevision: 8,
            },
        } satisfies Partial<PromotionRevisionConflictError>);
    });

    it("distinguishes archive state from a stale revision", async () => {
        const { db } = createDb({
            stale: true,
            currentRevision: 4,
            status: "archived",
            deletedAt: new Date(),
        });
        await expect(executePromotionRuleMutationBatch(
            db as never,
            "promo_1",
            4,
            [{ kind: "parent" } as never],
        )).rejects.toBeInstanceOf(PromotionStateConflictError);
    });
});
