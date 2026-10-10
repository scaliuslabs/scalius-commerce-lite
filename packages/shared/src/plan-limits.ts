/**
 * The deployment's Cloudflare plan profile: every limit Scalius adapts to the
 * Workers plan lives here as a value, decided once at deploy time.
 *
 * `pnpm deploy --plan paid` (or `SCALIUS_PLAN=paid`; `--plugin-sandbox`
 * implies it) writes the plan into the generated Wrangler config as the build
 * constant `__SCALIUS_PLAN__` (`define`, scripts/plan.mjs). It is neither an
 * environment variable nor a secret, and nothing reads it at request time
 * except through `planLimits()`. Without the flag nothing is defined and the
 * deployment is Free: the default must deploy and run on Workers Free.
 *
 * Rules the values keep:
 * - Free values fit Workers Free (10 ms CPU, 50 D1 queries and 50 external
 *   subrequests per invocation, 1,000 KV writes and 10,000 Queues operations a
 *   day; docs/FREE-PLAN.md). They are lighter, never different in kind.
 * - Paid values are what the code did before the plan existed, or stronger.
 *   `scripts/plan.test.mjs` pins them: a Paid value that gets weaker fails.
 * - Code reads values; it never branches on the plan's name.
 */

export type WorkersPlan = "free" | "paid";

/** How a new password hash is made. Existing hashes keep the parameters they carry. */
export type PasswordHashSpec =
  | { readonly algorithm: "pbkdf2-sha256"; readonly iterations: number }
  | { readonly algorithm: "scrypt"; readonly N: number; readonly r: number; readonly p: number };

export interface PlanLimits {
  readonly plan: WorkersPlan;
  /** Worker CPU limit (ms) written to the deploy config; null leaves the plan's own limit (Free is fixed at 10 ms). */
  readonly cpuMs: number | null;
  /** What a new password hash costs: it must fit the plan's CPU limit with the rest of a sign-in. */
  readonly password: PasswordHashSpec;
  readonly queue: {
    /**
     * `max_batch_size` of the `jobs` consumer (generated config): one invocation handles at most this
     * many messages. Bounded by the D1 queries an invocation may make (Free 50, Paid 1,000) over the
     * most a single message uses (a 20-product recommendation refresh: ~50 measured): Paid 15 keeps
     * the worst batch under 800, Free handles one message per invocation.
     */
    readonly consumerBatchSize: number;
    /** `max_batch_size` of the dead-letter consumer. */
    readonly dlqBatchSize: number;
    /** Bulk producers (rendition and catalogue fan-out) enqueue nothing while the queue's backlog is at or above this. */
    readonly bulkBacklogLimit: number;
    /** Most bulk messages one producer call enqueues; the rest waits for the next tick or continuation. */
    readonly bulkPageSize: number;
    /** Recommendation lists the nightly pass refreshes. */
    readonly nightlyRecommendationRefreshLimit: number;
    /** Products one `catalog.recommendations.refresh` message recomputes (one ranking statement each). */
    readonly recommendationProductsPerMessage: number;
    /** Products one `catalog.projections.rebuild` message recomputes before it queues the next chunk. */
    readonly catalogRebuildChunk: number;
    /**
     * A public read that shows an image still without renditions queues its
     * rendering at once (and marks it in KV so the next read does not queue it
     * again). Off, only the scheduled backfill renders: no queue message and no
     * KV write on the buyer's path.
     */
    readonly renditionsFromPublicReads: boolean;
  };
  /** Optional KV hints: D1 stays the authority, so a hint that is off costs a D1 read, never correctness. */
  readonly kv: {
    /** Checkout status and receipt hints written after an order commits (and on a status poll that missed them). */
    readonly checkoutRecoveryHints: boolean;
    /** The per-user permission snapshot cached for other isolates. */
    readonly permissionCache: boolean;
  };
  readonly maintenance: {
    /** The cron rotates through this many groups of sweeps, one group a run (1: every sweep every run). */
    readonly slices: number;
    /** Each sweep's row limit is this fraction of its full limit (1: the full limit). */
    readonly limitScale: number;
    /** Images the cron renders itself, without the queue, when the queue cannot take them. */
    readonly inlineRenditionsPerRun: number;
  };
  readonly lists: {
    /** Most rows a list counts for its total: `total` is exact up to it and reads "N+" beyond. */
    readonly countCap: number;
    /** Deepest OFFSET a numbered page may read; deeper pages use the keyset cursor. */
    readonly maxOffset: number;
    /**
     * Rows one slice of an "all matching" bulk action handles when each row
     * needs its own reads and writes (restore, permanent delete): a handful
     * of D1 queries per row must stay inside the plan's queries per request.
     * Batched actions (trash, status, category) always take 90.
     */
    readonly bulkPerRowSlice: number;
  };
  /**
   * Per-app ceilings (docs/platform/PLUGINS.md, "Quotas"). An app's manifest
   * `limits` apply within them; the platform takes the lower value.
   */
  readonly plugins: {
    /** CPU per invocation of a sandboxed app (the isolate's limit). */
    readonly cpuMs: number;
    /** Wall time per invocation (both loaders). */
    readonly wallMs: number;
    /** Platform calls (bridge and network) per invocation; Workers' own per-invocation ceilings (Free 50, Paid 1,000). */
    readonly subrequests: number;
    /** Bytes an app may keep in its storage and key/value data; writes stop above it (deletes still work). */
    readonly storageBytes: number;
    /** Event, route and cron runs per app a minute (functions and storefront output are paced by the platform). */
    readonly invocationsPerMinute: number;
    /** Limit breaches (at most one counted a minute) within an hour that stop the app. */
    readonly breachesBeforeStop: number;
  };
}

export const PLAN_LIMITS: Readonly<Record<WorkersPlan, PlanLimits>> = Object.freeze({
  free: Object.freeze({
    plan: "free",
    cpuMs: null,
    password: Object.freeze({ algorithm: "pbkdf2-sha256", iterations: 30_000 }),
    queue: Object.freeze({
      consumerBatchSize: 1,
      dlqBatchSize: 1,
      bulkBacklogLimit: 20,
      bulkPageSize: 10,
      nightlyRecommendationRefreshLimit: 150,
      recommendationProductsPerMessage: 5,
      catalogRebuildChunk: 90,
      renditionsFromPublicReads: false,
    }),
    kv: Object.freeze({ checkoutRecoveryHints: false, permissionCache: false }),
    maintenance: Object.freeze({ slices: 4, limitScale: 0.2, inlineRenditionsPerRun: 1 }),
    lists: Object.freeze({ countCap: 1_000, maxOffset: 1_000, bulkPerRowSlice: 8 }),
    plugins: Object.freeze({
      cpuMs: 50,
      wallMs: 10_000,
      subrequests: 50,
      storageBytes: 50 * 1024 * 1024,
      invocationsPerMinute: 600,
      breachesBeforeStop: 5,
    }),
  }),
  paid: Object.freeze({
    plan: "paid",
    cpuMs: 30_000,
    password: Object.freeze({ algorithm: "scrypt", N: 16_384, r: 16, p: 1 }),
    queue: Object.freeze({
      consumerBatchSize: 15,
      dlqBatchSize: 10,
      bulkBacklogLimit: 1_000,
      bulkPageSize: 1_000,
      nightlyRecommendationRefreshLimit: 3_000,
      recommendationProductsPerMessage: 20,
      catalogRebuildChunk: 900,
      renditionsFromPublicReads: true,
    }),
    kv: Object.freeze({ checkoutRecoveryHints: true, permissionCache: true }),
    maintenance: Object.freeze({ slices: 1, limitScale: 1, inlineRenditionsPerRun: 240 }),
    lists: Object.freeze({ countCap: 10_000, maxOffset: 10_000, bulkPerRowSlice: 90 }),
    plugins: Object.freeze({
      cpuMs: 200,
      wallMs: 30_000,
      subrequests: 1_000,
      storageBytes: 1024 * 1024 * 1024,
      invocationsPerMinute: 6_000,
      breachesBeforeStop: 5,
    }),
  }),
}) as Readonly<Record<WorkersPlan, PlanLimits>>;

/** The deploy-time constant (`define` in the generated Wrangler config); absent means Free. */
declare const __SCALIUS_PLAN__: WorkersPlan | undefined;

export function deployedPlan(): WorkersPlan {
  return typeof __SCALIUS_PLAN__ !== "undefined" && __SCALIUS_PLAN__ === "paid" ? "paid" : "free";
}

/** The limits this deployment runs with (read per call, never captured at module load). */
export function planLimits(plan: WorkersPlan = deployedPlan()): PlanLimits {
  return PLAN_LIMITS[plan];
}
