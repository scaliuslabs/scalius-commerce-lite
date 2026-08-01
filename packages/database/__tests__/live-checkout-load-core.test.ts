import { describe, expect, it } from "vitest";

import {
  assertDisposableLoadTarget,
  percentile,
  runOpenArrival,
  summarizeTimings,
} from "../scripts/live-checkout-load-core";

describe("live checkout load safety and timing", () => {
  it("requires an exact acknowledgement of a disposable HTTPS loadtest host", () => {
    expect(assertDisposableLoadTarget(
      "https://scalius-api-loadtest-20260802.example.workers.dev",
      "scalius-api-loadtest-20260802.example.workers.dev",
    ).origin).toBe("https://scalius-api-loadtest-20260802.example.workers.dev");

    expect(() => assertDisposableLoadTarget(
      "https://api.example.com",
      "api.example.com",
    )).toThrow(/loadtest/);
    expect(() => assertDisposableLoadTarget(
      "https://scalius-loadtest.example.com",
      "different.example.com",
    )).toThrow(/exactly match/);
    expect(() => assertDisposableLoadTarget(
      "http://scalius-loadtest.example.com",
      "scalius-loadtest.example.com",
    )).toThrow(/HTTPS/);
  });

  it("reports nearest-rank latency percentiles", () => {
    expect(percentile([100, 20, 40, 80, 60], 0.5)).toBe(60);
    expect(summarizeTimings([
      { serviceMs: 10, scheduledMs: 12, startLagMs: 2 },
      { serviceMs: 30, scheduledMs: 50, startLagMs: 20 },
    ], "scheduledMs")).toEqual({ min: 12, p50: 12, p95: 50, p99: 50, max: 50 });
  });

  it("records service and scheduled latency for an open-arrival execution", async () => {
    let time = 0;
    const result = await runOpenArrival({
      count: 1,
      ratePerSecond: 10,
      leadInMs: 0,
      now: () => time,
      async sleep(milliseconds) {
        time += milliseconds;
      },
      async execute(sequence) {
        time += 30;
        return sequence;
      },
    });

    expect(result.map(({ value }) => value)).toEqual([1]);
    expect(result[0]?.timing.serviceMs).toBe(30);
    expect(result[0]?.timing.scheduledMs).toBe(30);
    expect(result[0]?.timing.startLagMs).toBe(0);
  });
});
