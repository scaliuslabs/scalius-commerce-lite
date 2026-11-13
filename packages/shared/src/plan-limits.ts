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
    /**
     * Due events one drain dispatches to their webhook and app subscribers.
     * The drain costs the same few D1 queries whatever the count (one claim,
     * one fan-out read and write per target, one mark).
     */
    readonly eventsPerDrain: number;
    /** Webhook and app deliveries one scheduled drain sends (an outbound request and about 4 D1 queries each). */
    readonly deliveriesPerDrain: number;
    /** Deliveries sent right after a write, in the write's own invocation (its queries are mostly spent). */
    readonly deliveriesAfterWrite: number;
    /** Notification outbox rows one drain sends (about 12 D1 queries each: one context batch, receipts, the staff alert). */
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
    /** Dead courier bookings one run finishes (each ships its order: about 28 D1 queries). */
    readonly bookedClaimsPerRun: number;
    /** Each sweep's row limit is this fraction of its full limit (1: the full limit). */
    readonly limitScale: number;
    /**
     * History rows (checkout attempts, receipts, notifications with their delivery
     * receipts, review requests) retention deletes a UTC day at most: on Free a store
     * with a long history catches up within a bounded share of the 100,000 rows
     * written a day; Paid has no cap.
     */
    readonly retentionRowsPerDay: number;
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
    /**
     * Products a narrowed listing (a search, a filter, a selection) counts its
     * attribute and option facets over, reading each product's facet rows
     * (16 a product on the scale-proof store, about 40 rows a product with
     * its scope). A plain category, brand or shop-all page reads the
     * maintained counts at any size instead, and a larger narrowed category
     * or brand shows its own counts.
     */
    readonly facetLiveProducts: number;
    /**
     * Product rows one catalogue feed file (`/api/product-feed.xml`,
     * `/api/facebook-feed.xml`, `@scalius/shared/catalog-feed-files`) holds,
     * and so the most one feed request reads: each 100 is one feed page read,
     * so a request is bounded by this many products, never by the catalogue.
     * A larger catalogue is several files. The storefront learns the value
     * from the layout (`platform.feedProductsPerRequest`).
     */
    readonly feedProductsPerRequest: number;
  };
  /** Orders one per-row bulk order action handles per request (see `BulkOrderLimits`). */
  readonly bulkOrders: BulkOrderLimits;
  /**
   * Buyer uploads (`file` line inputs and checkout attributes,
   * `@scalius/shared/buyer-uploads`): an app declares its own size and count
   * within these and the platform takes the lower value. The API Worker reads
   * each file whole (128 MB of memory), so Free keeps files small.
   */
  readonly uploads: {
    /** Largest file one upload takes. */
    readonly maxBytes: number;
    /** Most files one input's answer names. */
    readonly maxFiles: number;
    /** Unattached uploads one visitor (by IP) may hold at once; the sweep frees them. */
    readonly stagedPerVisitor: number;
    /** Unattached uploads one sweep run deletes (each a guarded row delete and an R2 delete). */
    readonly sweepPerRun: number;
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
   * Per-app ceilings (packages/plugin-sdk/docs/apps.md, "Quotas"). An app's manifest
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
    /**
     * Days an approved app that is not running (turned off, stopped, failed,
     * an update waiting for approval) keeps its events, delivered when it
     * runs again; older ones are dropped.
     */
    readonly heldEventDays: number;
    /** Events such an app keeps at most; beyond them its oldest are dropped. */
    readonly heldEvents: number;
  };
}

/**
 * Orders one per-row bulk order action handles per request; the rest come
 * back as `remaining` and the dashboard sends them next. Each order costs its
 * own D1 calls and the request's after-response work (one customer message
 * on Free) counts against the same per-invocation cap (Free: 50 queries).
 */
export interface BulkOrderLimits {
  /** Bulk confirm: one read for the whole slice, then one batch per 30 orders (status, timeline line, message). */
  readonly confirm: number;
  /**
   * Of those, orders whose stock must be reserved again (a restored order):
   * each runs the full status change with its stock, so few fit a request.
   */
  readonly confirmStockRepairs: number;
  /** "Mark as sent" with your own courier: a fulfilment, its shipped status and its message per order. */
  readonly send: number;
  /** Booking a courier: a shipment claim, the courier's API call and the shipped status per order. */
  readonly ship: number;
}

export const PLAN_LIMITS: Readonly<Record<WorkersPlan, PlanLimits>> = Object.freeze({
  free: Object.freeze({
    plan: "free",
    cpuMs: null,
    password: Object.freeze({ algorithm: "pbkdf2-sha256", iterations: 30_000 }),
    sameOriginMedia: false,
    background: Object.freeze({
      eventsPerDrain: 20,
      deliveriesPerDrain: 4,
      deliveriesAfterWrite: 2,
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
      bookedClaimsPerRun: 1,
      limitScale: 0.2,
      retentionRowsPerDay: 6_000,
    }),
    lists: Object.freeze({ countCap: 1_000, maxOffset: 1_000, bulkPerRowSlice: 8, facetLiveProducts: 300, feedProductsPerRequest: 1_000 }),
    bulkOrders: Object.freeze({ confirm: 30, confirmStockRepairs: 1, send: 1, ship: 1 }),
    uploads: Object.freeze({ maxBytes: 5 * 1024 * 1024, maxFiles: 3, stagedPerVisitor: 20, sweepPerRun: 10 }),
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
      heldEventDays: 7,
      heldEvents: 2_000,
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
      deliveriesAfterWrite: 25,
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
      bookedClaimsPerRun: 10,
      limitScale: 1,
      retentionRowsPerDay: Number.POSITIVE_INFINITY,
    }),
    lists: Object.freeze({ countCap: 10_000, maxOffset: 10_000, bulkPerRowSlice: 90, facetLiveProducts: 5_000, feedProductsPerRequest: 5_000 }),
    bulkOrders: Object.freeze({ confirm: 90, confirmStockRepairs: 20, send: 30, ship: 20 }),
    uploads: Object.freeze({ maxBytes: 20 * 1024 * 1024, maxFiles: 10, stagedPerVisitor: 60, sweepPerRun: 50 }),
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
      heldEventDays: 30,
      heldEvents: 50_000,
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
