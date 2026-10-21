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
 *   subrequests per invocation; docs/FREE-PLAN.md). They are lighter, never
 *   different in kind.
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
  /**
   * Whether the storefront serves photos from its own origin (`/media/...`,
   * so the LCP image reuses the page's connection). Every photo then costs a
   * storefront Worker request, which Free (100,000 requests a day) cannot
   * afford: Free keeps the direct media address (the R2 custom domain, which
   * is not a Worker request) and its preconnect hints. The API hands this to
   * the storefront in the layout payload (`platform.sameOriginMedia`).
   */
  readonly sameOriginMedia: boolean;
  /**
   * Background work drains durable rows (outboxes, deliveries, claimed
   * payment events, cursors) in the invocation that wrote them (`waitUntil`)
   * and on every scheduled tick. It shares that invocation's D1 queries (Free
   * 50, Paid 1,000), so each drain takes at most this many items and leaves
   * the rest due for the next tick.
   */
  readonly background: {
    /** Due events one drain dispatches to their webhook and app subscribers. */
    readonly eventsPerDrain: number;
    /** Webhook and app deliveries one drain sends (an outbound request and a few D1 queries each). */
    readonly deliveriesPerDrain: number;
    /** Notification outbox rows one drain sends (about 30 D1 queries each: settings, templates, receipts). */
    readonly notificationsPerDrain: number;
    /** Claimed payment events one tick retries from their `webhook_events` rows. */
    readonly paymentEventsPerDrain: number;
    /** Settled orders one sweep hands to automatic fulfilment. */
    readonly autoFulfilPerRun: number;
    /** Apps whose due schedule slot one tick runs. */
    readonly pluginCronPerRun: number;
    /** Products whose recommendations a catalogue write recomputes right after it; the rotation heals the rest. */
    readonly recommendationProductsAfterWrite: number;
    /** Public products one recommendation rotation run visits, in id order. */
    readonly recommendationRotationPerRun: number;
    /** Products sold in the last day whose recommendations the nightly tick recomputes. */
    readonly nightlySoldRecommendationLimit: number;
    /** Products one buyer-state/facet projection rebuild chunk recomputes. */
    readonly catalogRebuildChunk: number;
    /** Rebuild chunks one drain runs before it leaves the cursor to the next tick. */
    readonly catalogRebuildChunksPerDrain: number;
    /** Products one band-only lap chunk recomputes (one statement: a card SKU probe each). */
    readonly catalogBandRefreshChunk: number;
    /** Products the nightly drift check compares with their sources (a rotating window). */
    readonly catalogDriftCheckPerNight: number;
    /** Chunks (90 items each) of due bulk runs one drain commits; the rest continue next tick. */
    readonly bulkRunChunksPerDrain: number;
    /**
     * Bundled apps the first ticks after a deploy install or update, one
     * tick at a time (an install is a few dozen D1 queries); the rest sync
     * on the next tick.
     */
    readonly bundledAppSyncsPerTick: number;
  };
  readonly maintenance: {
    /** A sweep tick comes every this many minutes (the cron fires every minute; apps/api/src/scheduled/slices.ts). */
    readonly sweepEveryMinutes: number;
    /** Jobs of the sweep rotation one sweep tick runs (at least the rotation's length: every job on every sweep tick). */
    readonly sweepsPerTick: number;
    /** Expired reservations one run releases (each is a guarded stock write). */
    readonly inventoryExpiryPerRun: number;
    /** Order cleanup includes inventory/gift-card repair; reserve one invocation per bounded page. */
    readonly staleOrdersPerRun: number;
    /** Each stale/replaced upload requires its own guarded write. */
    readonly digitalUploadsPerState: number;
    /** Each unattached image requires a guarded row delete. */
    readonly orphanAttachmentsPerRun: number;
    /** Each sweep's row limit is this fraction of its full limit (1: the full limit). */
    readonly limitScale: number;
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
   * Items one batch create (`products.batch_create`, `categories.batch_create`,
   * `brands.batch_create`; routes/admin/resources-batch.ts) accepts. Each item
   * costs a few D1 queries of the invocation, so the Free bound keeps one call
   * well under its 50.
   */
  readonly batchCreates: {
    readonly products: number;
    readonly categories: number;
    readonly brands: number;
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
    /** Emails, SMS, staff notices and buyer pushes one app sends a minute (`ctx.messaging`). */
    readonly messagesPerMinute: number;
    /** Background jobs (`ctx.jobs.start`) one app may have running at once; a start beyond it is refused. */
    readonly runningJobs: number;
  };
}

export const PLAN_LIMITS: Readonly<Record<WorkersPlan, PlanLimits>> = Object.freeze({
  free: Object.freeze({
    plan: "free",
    cpuMs: null,
    password: Object.freeze({ algorithm: "pbkdf2-sha256", iterations: 30_000 }),
    sameOriginMedia: false,
    background: Object.freeze({
      eventsPerDrain: 2,
      deliveriesPerDrain: 2,
      notificationsPerDrain: 1,
      paymentEventsPerDrain: 1,
      autoFulfilPerRun: 1,
      pluginCronPerRun: 1,
      recommendationProductsAfterWrite: 5,
      recommendationRotationPerRun: 4,
      nightlySoldRecommendationLimit: 5,
      catalogRebuildChunk: 90,
      catalogRebuildChunksPerDrain: 1,
      catalogBandRefreshChunk: 1_000,
      catalogDriftCheckPerNight: 450,
      bulkRunChunksPerDrain: 3, bundledAppSyncsPerTick: 1,
    }),
    maintenance: Object.freeze({
      sweepEveryMinutes: 1,
      sweepsPerTick: 1,
      inventoryExpiryPerRun: 4,
      staleOrdersPerRun: 2,
      digitalUploadsPerState: 6,
      orphanAttachmentsPerRun: 10,
      limitScale: 0.2,
    }),
    lists: Object.freeze({ countCap: 1_000, maxOffset: 1_000, bulkPerRowSlice: 8 }),
    batchCreates: Object.freeze({ products: 4, categories: 12, brands: 19 }),
    plugins: Object.freeze({
      cpuMs: 50,
      wallMs: 10_000,
      subrequests: 50,
      storageBytes: 50 * 1024 * 1024,
      invocationsPerMinute: 600,
      breachesBeforeStop: 5,
      messagesPerMinute: 60,
      runningJobs: 3,
    }),
  }),
  paid: Object.freeze({
    plan: "paid",
    cpuMs: 30_000,
    password: Object.freeze({ algorithm: "scrypt", N: 16_384, r: 16, p: 1 }),
    sameOriginMedia: true,
    background: Object.freeze({
      eventsPerDrain: 50,
      deliveriesPerDrain: 25,
      notificationsPerDrain: 20,
      paymentEventsPerDrain: 10,
      autoFulfilPerRun: 50,
      pluginCronPerRun: 25,
      recommendationProductsAfterWrite: 40,
      recommendationRotationPerRun: 32,
      nightlySoldRecommendationLimit: 200,
      catalogRebuildChunk: 900,
      catalogRebuildChunksPerDrain: 10,
      catalogBandRefreshChunk: 5_000,
      catalogDriftCheckPerNight: 9_000,
      bulkRunChunksPerDrain: 12, bundledAppSyncsPerTick: 1_000,
    }),
    maintenance: Object.freeze({
      sweepEveryMinutes: 15,
      sweepsPerTick: 64,
      inventoryExpiryPerRun: 50,
      staleOrdersPerRun: 25,
      digitalUploadsPerState: 25,
      orphanAttachmentsPerRun: 50,
      limitScale: 1,
    }),
    lists: Object.freeze({ countCap: 10_000, maxOffset: 10_000, bulkPerRowSlice: 90 }),
    batchCreates: Object.freeze({ products: 20, categories: 50, brands: 50 }),
    plugins: Object.freeze({
      cpuMs: 200,
      wallMs: 30_000,
      subrequests: 1_000,
      storageBytes: 1024 * 1024 * 1024,
      invocationsPerMinute: 6_000,
      breachesBeforeStop: 5,
      messagesPerMinute: 300,
      runningJobs: 10,
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
