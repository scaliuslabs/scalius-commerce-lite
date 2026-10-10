import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS, deployedPlan, planLimits } from "./plan-limits";

/**
 * What the code did before the plan profile existed. A Paid store must keep
 * at least this: lowering any of these values for Paid is a regression, and
 * this test fails on it. (The Free profile may be lighter.)
 */
const BEFORE_THE_PROFILE = {
  /** apps/api/wrangler.jsonc `limits.cpu_ms`. */
  cpuMs: 30_000,
  /** better-auth's own `hashPassword`: scrypt N=16384, r=16, p=1. */
  scrypt: { N: 16_384, r: 16, p: 1 },
  /** apps/api/wrangler.jsonc `queues.consumers[jobs].max_batch_size` and the DLQ consumer's. */
  consumerBatchSize: 10,
  dlqBatchSize: 10,
  /** MEDIA_RENDITION_FANOUT_MAX_PER_RUN: media jobs enqueued by one 15-minute run. */
  mediaFanOutPerRun: 1_000,
  /** NIGHTLY_RECOMMENDATION_REFRESH_LIMIT. */
  nightlyRecommendationRefreshLimit: 3_000,
  /** RECOMMENDATION_REFRESH_PRODUCTS_PER_MESSAGE and CATALOG_PROJECTION_REBUILD_CHUNK. */
  recommendationProductsPerMessage: 20,
  catalogRebuildChunk: 900,
  /** Every sweep ran its full limit, and the cron rendered up to MEDIA_RENDITION_BACKFILL_MAX_PER_RUN images itself. */
  sweepLimitScale: 1,
  inlineRenditionsPerRun: 240,
  /** Apps: the manifest's own ceilings (cpuMs 200, wallMs 30 s) and PLUGIN_SANDBOX_SUBREQUESTS. */
  pluginCpuMs: 200,
  pluginWallMs: 30_000,
  pluginSubrequests: 200,
} as const;

describe("plan profile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is Free unless the deploy defined the plan", () => {
    expect(deployedPlan()).toBe("free");
    expect(planLimits()).toBe(PLAN_LIMITS.free);
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    expect(deployedPlan()).toBe("paid");
    expect(planLimits()).toBe(PLAN_LIMITS.paid);
    // Anything but the exact word is Free: a typo must never grant Paid values.
    vi.stubGlobal("__SCALIUS_PLAN__", "Paid");
    expect(deployedPlan()).toBe("free");
    vi.stubGlobal("__SCALIUS_PLAN__", "enterprise");
    expect(deployedPlan()).toBe("free");
  });

  it("reads the plan per call, never at module load", () => {
    expect(planLimits().plan).toBe("free");
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    expect(planLimits().plan).toBe("paid");
    vi.unstubAllGlobals();
    expect(planLimits().plan).toBe("free");
  });

  describe("Paid keeps at least what the code did before the profile", () => {
    const paid = PLAN_LIMITS.paid;

    it("apps keep the CPU, wall time and calls an invocation had before the profile", () => {
      expect(paid.plugins.cpuMs).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.pluginCpuMs);
      expect(paid.plugins.wallMs).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.pluginWallMs);
      expect(paid.plugins.subrequests).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.pluginSubrequests);
      // New quotas: Paid is never below Free.
      expect(paid.plugins.storageBytes).toBeGreaterThanOrEqual(PLAN_LIMITS.free.plugins.storageBytes);
      expect(paid.plugins.invocationsPerMinute).toBeGreaterThanOrEqual(PLAN_LIMITS.free.plugins.invocationsPerMinute);
      expect(paid.plugins.breachesBeforeStop).toBeGreaterThanOrEqual(PLAN_LIMITS.free.plugins.breachesBeforeStop);
    });

    it("CPU stays at 30 s", () => {
      expect(paid.cpuMs).toBe(BEFORE_THE_PROFILE.cpuMs);
    });

    it("password hashing is at least as strong as scrypt N=16384 r=16 p=1", () => {
      expect(paid.password.algorithm).toBe("scrypt");
      if (paid.password.algorithm !== "scrypt") return;
      expect(paid.password.N).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.scrypt.N);
      expect(paid.password.r).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.scrypt.r);
      expect(paid.password.p).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.scrypt.p);
    });

    it("queue batches and bulk throughput are no smaller", () => {
      expect(paid.queue.consumerBatchSize).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.consumerBatchSize);
      expect(paid.queue.dlqBatchSize).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.dlqBatchSize);
      expect(paid.queue.bulkPageSize).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.mediaFanOutPerRun);
      expect(paid.queue.bulkBacklogLimit).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.mediaFanOutPerRun);
      expect(paid.queue.nightlyRecommendationRefreshLimit).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.nightlyRecommendationRefreshLimit);
      expect(paid.queue.recommendationProductsPerMessage).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.recommendationProductsPerMessage);
      expect(paid.queue.catalogRebuildChunk).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.catalogRebuildChunk);
    });

    it("every KV hint and on-demand rendition stays on", () => {
      expect(Object.values(paid.kv)).toEqual(Object.values(paid.kv).map(() => true));
      expect(paid.queue.renditionsFromPublicReads).toBe(true);
    });

    it("every sweep runs on every cron tick at its full limit", () => {
      expect(paid.maintenance.slices).toBe(1);
      expect(paid.maintenance.limitScale).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.sweepLimitScale);
      expect(paid.maintenance.inlineRenditionsPerRun).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.inlineRenditionsPerRun);
    });
  });

  it("Free is never heavier than Paid, and fits Free's published limits", () => {
    const { free, paid } = { free: PLAN_LIMITS.free, paid: PLAN_LIMITS.paid };
    expect(free.cpuMs).toBeNull();
    expect(free.queue.consumerBatchSize).toBeLessThanOrEqual(paid.queue.consumerBatchSize);
    expect(free.queue.bulkPageSize).toBeLessThanOrEqual(paid.queue.bulkPageSize);
    expect(free.queue.bulkBacklogLimit).toBeLessThanOrEqual(paid.queue.bulkBacklogLimit);
    expect(free.lists.countCap).toBeLessThanOrEqual(paid.lists.countCap);
    expect(free.lists.maxOffset).toBeLessThanOrEqual(paid.lists.maxOffset);
    expect(free.lists.bulkPerRowSlice).toBeLessThanOrEqual(paid.lists.bulkPerRowSlice);
    expect(paid.lists.bulkPerRowSlice).toBe(90);
    expect(free.maintenance.slices).toBeGreaterThanOrEqual(paid.maintenance.slices);
    expect(free.maintenance.limitScale).toBeLessThanOrEqual(paid.maintenance.limitScale);
    expect(free.maintenance.limitScale).toBeGreaterThan(0);
    expect(Number.isInteger(free.maintenance.slices) && free.maintenance.slices >= 1).toBe(true);
    // A fixed Free CPU of 10 ms leaves no room for a memory-hard hash.
    expect(free.password.algorithm).toBe("pbkdf2-sha256");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.paid)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.paid.queue)).toBe(true);
  });
});
