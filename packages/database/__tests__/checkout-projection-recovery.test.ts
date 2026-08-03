import { describe, expect, it, vi } from "vitest";

import {
  buildCheckoutProjectionBatchStatements,
  projectCheckoutOutboxes,
  recoverPendingCheckoutProjections,
} from "../src/checkout-projection";

describe("checkout projection recovery", () => {
  it("avoids target-table aliases in updates for TursoDB compatibility", () => {
    const updateStatements = buildCheckoutProjectionBatchStatements(["outbox_1"])
      .map((statement) => statement.sql)
      .filter((sql) => /\bUPDATE\b/i.test(sql));

    expect(updateStatements).not.toHaveLength(0);
    for (const sql of updateStatements) {
      expect(sql).not.toMatch(/\bUPDATE\s+(?:orders|customers)\s+AS\b/i);
    }
  });

  it("projects a bounded page sequentially and continues after one failure", async () => {
    let active = 0;
    let maximumActive = 0;
    const completedIds: string[] = [];
    const transport = {
      all: vi.fn(async () => [
        { id: "outbox_1", orderCount: 1 },
        { id: "outbox_broken", orderCount: 1 },
        { id: "outbox_2", orderCount: 1 },
      ]),
      atomic: vi.fn(async (statements: readonly { args: readonly unknown[] }[]) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const outboxIds = JSON.parse(String(statements[0]?.args[0])) as string[];
        await Promise.resolve();
        active -= 1;
        if (outboxIds.includes("outbox_broken")) throw new Error("projection failed");
        completedIds.push(...outboxIds);
      }),
    };

    const result = await recoverPendingCheckoutProjections(transport, 3);

    expect(result).toEqual({
      scanned: 3,
      completed: 2,
      failed: 1,
      hasMore: true,
    });
    expect(maximumActive).toBe(1);
    expect(completedIds).toEqual(["outbox_1", "outbox_2"]);
    expect(transport.atomic).toHaveBeenCalledTimes(4);
    expect(transport.all).toHaveBeenCalledWith(expect.objectContaining({ args: [3] }));
  });

  it("isolates outboxes after a grouped transaction failure", async () => {
    const completedIds: string[] = [];
    const transport = {
      atomic: vi.fn(async (statements: readonly { args: readonly unknown[] }[]) => {
        const outboxIds = JSON.parse(String(statements[0]?.args[0])) as string[];
        if (outboxIds.length > 1 || outboxIds.includes("outbox_broken")) {
          throw new Error("projection failed");
        }
        completedIds.push(...outboxIds);
      }),
    };

    await expect(projectCheckoutOutboxes(transport, [
      "outbox_1",
      "outbox_broken",
      "outbox_2",
    ])).resolves.toEqual({
      completedIds: ["outbox_1", "outbox_2"],
      failedIds: ["outbox_broken"],
    });
    expect(completedIds).toEqual(["outbox_1", "outbox_2"]);
    expect(transport.atomic).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed scan rows without invoking a transaction", async () => {
    const transport = {
      all: vi.fn(async () => [
        { id: null, orderCount: 1 },
        { id: "", orderCount: 1 },
      ]),
      atomic: vi.fn(async () => undefined),
    };

    await expect(recoverPendingCheckoutProjections(transport, 25)).resolves.toEqual({
      scanned: 2,
      completed: 0,
      failed: 2,
      hasMore: false,
    });
    expect(transport.atomic).not.toHaveBeenCalled();
  });
});
