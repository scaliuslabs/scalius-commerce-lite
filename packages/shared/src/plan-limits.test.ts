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
  /** NIGHTLY_RECOMMENDATION_REFRESH_LIMIT: recommendation lists refreshed per day. */
  nightlyRecommendationRefreshLimit: 3_000,
  /** RECOMMENDATION_REFRESH_PRODUCTS_PER_MESSAGE and CATALOG_PROJECTION_REBUILD_CHUNK. */
  recommendationProductsPerMessage: 20,
  catalogRebuildChunk: 900,
  /** Every sweep ran its full limit. */
  sweepLimitScale: 1,
  /** INVENTORY_EXPIRY_SWEEP_LIMIT at that scale. */
  inventoryExpiryPerRun: 50,
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

    it("photos are served from the store's own origin on Paid only", () => {
      expect(paid.sameOriginMedia).toBe(true);
      expect(PLAN_LIMITS.free.sameOriginMedia).toBe(false);
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

    it("catalogue background throughput is no smaller", () => {
      // The rotation (every 15-minute sweep tick) refreshes at least as many lists a day as the nightly pass did.
      expect(paid.background.recommendationRotationPerRun * 96).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.nightlyRecommendationRefreshLimit);
      // A catalogue write refreshes at least one message's worth of products right after it.
      expect(paid.background.recommendationProductsAfterWrite).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.recommendationProductsPerMessage);
      expect(paid.background.catalogRebuildChunk).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.catalogRebuildChunk);
    });

    it("every sweep runs every 15 minutes at its full limit", () => {
      expect(paid.maintenance.sweepEveryMinutes).toBeLessThanOrEqual(15);
      // At least every job of the rotation (apps/api/src/scheduled-maintenance.test.ts checks the length).
      expect(paid.maintenance.sweepsPerTick).toBeGreaterThanOrEqual(32);
      expect(paid.maintenance.inventoryExpiryPerRun).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.inventoryExpiryPerRun);
      expect(paid.maintenance.limitScale).toBeGreaterThanOrEqual(BEFORE_THE_PROFILE.sweepLimitScale);
    });
  });

  it("Free is never heavier than Paid, and fits Free's published limits", () => {
    const { free, paid } = { free: PLAN_LIMITS.free, paid: PLAN_LIMITS.paid };
    expect(free.cpuMs).toBeNull();
    for (const key of Object.keys(paid.background) as Array<keyof typeof paid.background>) {
      expect(free.background[key], key).toBeLessThanOrEqual(paid.background[key]);
      expect(free.background[key] >= 0, key).toBe(true);
    }
    // Every drain makes progress on Free.
    for (const key of ["eventsPerDrain", "deliveriesPerDrain", "notificationsPerDrain", "paymentEventsPerDrain", "autoFulfilPerRun", "pluginCronPerRun", "recommendationRotationPerRun", "catalogRebuildChunksPerDrain", "bulkRunChunksPerDrain"] as const) {
      expect(free.background[key], key).toBeGreaterThanOrEqual(1);
    }
    expect(free.lists.countCap).toBeLessThanOrEqual(paid.lists.countCap);
    expect(free.lists.maxOffset).toBeLessThanOrEqual(paid.lists.maxOffset);
    expect(free.lists.bulkPerRowSlice).toBeLessThanOrEqual(paid.lists.bulkPerRowSlice);
    // Batch creates: Free fits Workers Free's 50 D1 queries (routes/admin/resources-batch.d1.test.ts measures it).
    for (const key of ["products", "categories", "brands"] as const) {
      expect(free.batchCreates[key], key).toBeLessThanOrEqual(paid.batchCreates[key]);
      expect(free.batchCreates[key], key).toBeGreaterThanOrEqual(1);
    }
    expect(paid.batchCreates).toEqual({ products: 20, categories: 50, brands: 50 });
    expect(paid.lists.bulkPerRowSlice).toBe(90);
    for (const key of ["sweepsPerTick", "inventoryExpiryPerRun", "staleOrdersPerRun", "digitalUploadsPerState", "orphanAttachmentsPerRun", "limitScale"] as const) {
      expect(free.maintenance[key], key).toBeLessThanOrEqual(paid.maintenance[key]);
      expect(free.maintenance[key], key).toBeGreaterThan(0);
    }
    // Free runs one small job a minute instead of every job each quarter hour.
    expect(free.maintenance.sweepEveryMinutes).toBe(1);
    expect(free.maintenance.sweepsPerTick).toBe(1);
    // A fixed Free CPU of 10 ms leaves no room for a memory-hard hash.
    expect(free.password.algorithm).toBe("pbkdf2-sha256");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.paid)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.paid.background)).toBe(true);
  });
});
