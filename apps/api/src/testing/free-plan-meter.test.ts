import { describe, expect, it } from "vitest";
import { createFreePlanMeter } from "./free-plan-meter";

describe("Free plan measurement boundaries", () => {
  it("includes waitUntil work and keeps later setup out of the completed measurement", async () => {
    const d1 = {
      prepare: () => ({ run: async () => ({ success: true, results: [], meta: { changes: 1 } }) }),
    } as unknown as D1Database;
    const meter = createFreePlanMeter({ d1 });
    const write = () => meter.bindings.DB!.prepare("INSERT INTO example VALUES (1)").run();

    const first = await meter.measure(async () => {
      await write();
      meter.ctx.waitUntil(Promise.resolve().then(write));
    });
    expect(first.counters).toMatchObject({ d1Calls: 2, d1Statements: 2, waitUntilTasks: 1 });
    const completed = { ...first.counters };

    // The budget runner prepares the next order outside its measurement.
    await write();
    await meter.cache.match("https://shop.test/setup");
    expect(first.counters).toEqual(completed);

    const second = await meter.measure(write);
    expect(second.counters).toMatchObject({ d1Calls: 1, d1Statements: 1, cacheOps: 0, waitUntilTasks: 0 });
    expect(first.counters).toEqual(completed);
  });
});
