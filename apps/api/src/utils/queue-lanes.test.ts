import { describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";
import { bulkQueueCapacity, bulkQueueState, queueLane, queueLaneOrder } from "./queue-lanes";

describe("queue lanes", () => {
  it("puts renditions and catalogue refreshes in the bulk lane and everything else, even the unknown, in the urgent one", () => {
    for (const type of ["media.render_variants", "catalog.recommendations.refresh", "catalog.projections.rebuild"]) {
      expect(queueLane(type)).toBe("bulk");
    }
    for (const type of ["auth.send_otp", "payment.event", "notification", "order.notification", "order.auto_fulfil", "events.dispatch", "webhooks.deliver", "plugins.deliver", "something.new", undefined, 7]) {
      expect(queueLane(type)).toBe("urgent");
    }
  });

  it("orders a batch urgent first, each lane in arrival order", () => {
    const bodies = [
      { type: "media.render_variants" },
      { type: "auth.send_otp" },
      { type: "catalog.projections.rebuild" },
      { type: "payment.event" },
      { type: "media.render_variants" },
      null,
    ];
    expect(queueLaneOrder(bodies)).toEqual([1, 3, 5, 0, 2, 4]);
    expect(queueLaneOrder([])).toEqual([]);
  });
});

describe.each(["free", "paid"] as const)("bulk capacity on the %s profile", (plan) => {
  const limits = PLAN_LIMITS[plan].queue;
  const queueWith = (backlogCount: number) => ({ metrics: vi.fn(async () => ({ backlogCount })) });

  it("is one page into an empty queue, and what is left under the backlog limit as it fills", async () => {
    expect(await bulkQueueCapacity(queueWith(0), limits)).toBe(limits.bulkPageSize);
    expect(await bulkQueueCapacity(queueWith(limits.bulkBacklogLimit - 3), limits)).toBe(Math.min(3, limits.bulkPageSize));
    expect(await bulkQueueCapacity(queueWith(limits.bulkBacklogLimit), limits)).toBe(0);
    expect(await bulkQueueCapacity(queueWith(limits.bulkBacklogLimit * 10), limits)).toBe(0);
  });

  it("is never more than a page, however empty the queue", async () => {
    expect(limits.bulkPageSize).toBeLessThanOrEqual(limits.bulkBacklogLimit);
    expect(await bulkQueueCapacity(queueWith(0), { ...limits, bulkBacklogLimit: limits.bulkPageSize * 50 })).toBe(limits.bulkPageSize);
  });

  it("treats a queue that cannot report as empty, one that fails to report as busy, and no queue as none", async () => {
    expect(await bulkQueueCapacity({}, limits)).toBe(limits.bulkPageSize);
    expect(await bulkQueueCapacity({ metrics: async () => { throw new Error("metrics unavailable"); } }, limits)).toBe(0);
    expect(await bulkQueueCapacity({ metrics: async () => ({ backlogCount: Number.NaN }) }, limits)).toBe(0);
    expect(await bulkQueueCapacity(undefined, limits)).toBe(0);
  });

  it("reports the backlog beside the room, so a producer can start behind the jobs already queued", async () => {
    expect(await bulkQueueState(queueWith(7), limits)).toEqual({ backlog: 7, capacity: Math.min(limits.bulkPageSize, limits.bulkBacklogLimit - 7) });
    expect(await bulkQueueState({}, limits)).toEqual({ backlog: null, capacity: limits.bulkPageSize });
    expect(await bulkQueueState({ metrics: async () => { throw new Error("down"); } }, limits)).toEqual({ backlog: null, capacity: 0 });
    expect(await bulkQueueState(undefined, limits)).toEqual({ backlog: null, capacity: 0 });
  });

  it("reads the deployed plan's limits when none are given", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", plan);
    try {
      expect(await bulkQueueCapacity(queueWith(0))).toBe(limits.bulkPageSize);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
