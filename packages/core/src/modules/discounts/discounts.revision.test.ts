import { describe, expect, it, vi } from "vitest";

import { discounts } from "@scalius/database/schema";
import {
  DiscountRevisionConflictError,
  DiscountStateConflictError,
  executeDiscountRuleMutationBatch,
} from "./discounts.revision";

function createDb(options: {
  stale?: boolean;
  currentRevision?: number;
  deletedAt?: Date | null;
} = {}) {
  const batch = vi.fn(async (statements: Array<{ kind: string }>) => {
    if (options.stale) throw new Error("malformed JSON");
    return statements.map((statement) => {
      if (statement.kind === "revision") {
        return [{ revision: (options.currentRevision ?? 4) + 1 }];
      }
      return [{ ok: 1 }];
    });
  });
  const db = {
    select() {
      const chain: Record<string, unknown> = { kind: "guard" };
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => ({
        get: async () => ({
          revision: options.currentRevision ?? 4,
          deletedAt: options.deletedAt ?? null,
        }),
      }));
      return chain;
    },
    update(table: unknown) {
      expect(table).toBe(discounts);
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

describe("discount rule revision batches", () => {
  it("guards every rule statement and increments once in the same batch", async () => {
    const { db, batch } = createDb({ currentRevision: 4 });

    const result = await executeDiscountRuleMutationBatch(
      db as never,
      "disc_1",
      4,
      [{ kind: "parent" } as never, { kind: "scope" } as never],
    );

    expect(batch.mock.calls[0]?.[0].map((statement) => statement.kind)).toEqual([
      "guard",
      "parent",
      "scope",
      "revision",
    ]);
    expect(result).toEqual({
      mutationResults: [[{ ok: 1 }], [{ ok: 1 }]],
      revision: 5,
    });
  });

  it("returns authoritative stale-write details without running a partial retry", async () => {
    const { db } = createDb({ stale: true, currentRevision: 7 });

    const error = await executeDiscountRuleMutationBatch(
      db as never,
      "disc_1",
      4,
      [{ kind: "parent" } as never, { kind: "scope" } as never],
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DiscountRevisionConflictError);
    expect(error).toMatchObject({
      status: 409,
      code: "DISCOUNT_REVISION_CONFLICT",
      details: {
        discountId: "disc_1",
        expectedRevision: 4,
        currentRevision: 7,
      },
    });
  });

  it("distinguishes a lifecycle change from a stale rule revision", async () => {
    const { db } = createDb({
      stale: true,
      currentRevision: 4,
      deletedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    await expect(executeDiscountRuleMutationBatch(
      db as never,
      "disc_1",
      4,
      [{ kind: "parent" } as never],
    )).rejects.toBeInstanceOf(DiscountStateConflictError);
  });

  it("does not relabel an unrelated malformed-json mutation failure", async () => {
    const { db } = createDb({ stale: true, currentRevision: 4 });

    const error = await executeDiscountRuleMutationBatch(
      db as never,
      "disc_1",
      4,
      [{ kind: "parent" } as never],
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DiscountRevisionConflictError);
  });
});
