import { describe, expect, it } from "vitest";

import {
  assertDisposableDatabaseTarget,
  assertDisposableDatabaseProvisionTarget,
  assertDisposableLoadTarget,
  assertTursoLoadBillingIsolation,
  LOADTEST_TARGET_PURPOSE,
  percentile,
  runOpenArrival,
  summarizeTimings,
} from "../scripts/live-checkout-load-core";

describe("live checkout load safety and timing", () => {
  it("requires Turso load billing to be isolated from production", () => {
    expect(assertTursoLoadBillingIsolation({
      loadOrganization: "scalius-capacity",
      acknowledgedLoadOrganization: "scalius-capacity",
      productionOrganization: "scalius-production",
      acknowledgedProductionOrganization: "scalius-production",
    })).toEqual({
      loadOrganization: "scalius-capacity",
      productionOrganization: "scalius-production",
    });

    expect(assertTursoLoadBillingIsolation({
      loadOrganization: "scalius-capacity",
      acknowledgedLoadOrganization: "scalius-capacity",
      productionOrganization: "none",
      acknowledgedProductionOrganization: "none",
    })).toEqual({
      loadOrganization: "scalius-capacity",
      productionOrganization: null,
    });

    expect(() => assertTursoLoadBillingIsolation({
      loadOrganization: "shared-organization",
      acknowledgedLoadOrganization: "shared-organization",
      productionOrganization: "shared-organization",
      acknowledgedProductionOrganization: "shared-organization",
    })).toThrow(/isolated from production/);
    expect(() => assertTursoLoadBillingIsolation({
      loadOrganization: "scalius-capacity",
      acknowledgedLoadOrganization: "wrong-organization",
      productionOrganization: "none",
      acknowledgedProductionOrganization: "none",
    })).toThrow(/exactly match the load organization/);
  });

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

  it("requires an acknowledged database host and an exact high-entropy sentinel", () => {
    const databaseUrl = "turso://scalius-loadtest-20260802-a1b2.example.turso.io";
    const targetId = "lt_a1b2c3d4e5f60708";
    const sentinelRows = [{
      purpose: LOADTEST_TARGET_PURPOSE,
      target_id: targetId,
      database_hostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      fixture_namespace: targetId,
    }];

    expect(assertDisposableDatabaseTarget({
      databaseUrl,
      acknowledgedDatabaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: targetId,
      sentinelRows,
    })).toEqual({
      targetId,
      databaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      fixtureNamespace: targetId,
    });

    expect(assertDisposableDatabaseProvisionTarget({
      databaseUrl,
      acknowledgedDatabaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: targetId,
    })).toEqual({
      targetId,
      databaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      fixtureNamespace: targetId,
    });

    expect(() => assertDisposableDatabaseTarget({
      databaseUrl: "turso://scalius-demo-live-turso-test.example.turso.io",
      acknowledgedDatabaseHostname: "scalius-demo-live-turso-test.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: targetId,
      sentinelRows,
    })).toThrow(/contain loadtest/);
    expect(() => assertDisposableDatabaseTarget({
      databaseUrl,
      acknowledgedDatabaseHostname: "different.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: targetId,
      sentinelRows,
    })).toThrow(/exactly match the database hostname/);
    expect(() => assertDisposableDatabaseTarget({
      databaseUrl,
      acknowledgedDatabaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: "lt_ffffffffffffffff",
      sentinelRows,
    })).toThrow(/exactly match LOADTEST_TARGET_ID/);
    expect(() => assertDisposableDatabaseTarget({
      databaseUrl,
      acknowledgedDatabaseHostname: "scalius-loadtest-20260802-a1b2.example.turso.io",
      expectedTargetId: targetId,
      acknowledgedTargetId: targetId,
      sentinelRows: [],
    })).toThrow(/exactly one/);
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
