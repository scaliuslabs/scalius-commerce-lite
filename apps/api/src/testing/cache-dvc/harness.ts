/**
 * The DVC differential property harness (CACHE-DESIGN §7 items 1 and 4).
 *
 * One in-process API over a migrated, seeded SQLite store (D1 binding, or the
 * real Turso adapter over the same file), a two-level cache model and a
 * random walk:
 *
 * - API part cache (G2, Δ = 0). Every public read in `routes.ts` is cached
 *   with the dependency set, clock `s0`, `validUntil` and soft age its render
 *   recorded. After every step every entry is validated; an entry the
 *   validator calls valid must be byte-identical to a fresh render, else the
 *   run fails naming the route, the entry's keys and the rows that changed
 *   after it rendered. Invalid entries are re-rendered (and counted; an
 *   invalidation whose fresh body is unchanged is "spurious", the precision
 *   metric).
 * - Storefront page cache (G1, Δ). Pages are composed from parts read through
 *   the part cache; hits are validated against a per-data-center frontier
 *   (§6.7) refreshed blocking, ahead of time, and by racing refreshers that
 *   land out of order. A served page must have a frontier no older than Δ,
 *   no dependency changed in (s0, F.S] by the ground-truth clock, and a body
 *   equal to the page rendered at F.S.
 *
 * Writes are random row mutations of any table, curated service writes,
 * stock-band walks, category tree moves and clock jumps across scheduled
 * promotion boundaries. Optionally, writes are injected between the
 * statements of a render (the race mode of §7 item 4).
 *
 * Everything random derives from one seed; a failure prints the seed and the
 * step to replay.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  createMigratedSqlite,
  createSqliteD1Binding,
} from "@scalius/database/testing/sqlite-d1";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { renderPublicRead } from "../../public-read";
import { CURATED_ACTIONS, type CuratedAction } from "./actions";
import {
  hasTriggerClock,
  ReferenceClock,
  sqliteClockSql,
  TriggerClock,
  type DvcClock,
} from "./clocks";
import { MutationCoverage, RowMutator, TRIGGER_OWNED_TABLES, type Mutation } from "./mutations";
import {
  coarseTableRecorder,
  headerDependencies,
  type DependencyRecorder,
  type RecordedDependencies,
} from "./recorders";
import { Rng } from "./rng";
import { RowLog, type LoggedChange } from "./row-log";
import { dvcPageCatalogue, dvcPartCatalogue, type DvcPage } from "./routes";
import { loadSchemaModel, type SchemaModel } from "./schema-model";
import { DVC_IDS, DVC_SEED_EPOCH, seedDvcStore } from "./seed-store";
import {
  DVC_API_VERSION,
  referenceFrontierModel,
  referencePartValidator,
  type DvcFrontierModel,
  type DvcPartValidator,
  type EntryMeta,
  type Frontier,
  type PageEntryMeta,
} from "./validators";

export interface DvcHarnessConfig {
  readonly seed: string;
  /** `d1`: the D1 binding; `turso`: the real Turso adapter (needs `providerDatabase`). */
  readonly provider?: "d1" | "turso";
  /** `auto` uses S1's trigger tables when the migrations have them. */
  readonly clock?: "auto" | "reference" | "triggers";
  /** Storefront staleness bound Δ, ms. */
  readonly deltaMs?: number;
  /** Frontier entries kept per data center (4,000 in production; small values exercise trimming). */
  readonly frontierCap?: number;
  /** Rows per frontier delta read. */
  readonly frontierDeltaLimit?: number;
  /** Probability that a statement of a render is preceded by an injected committed write. */
  readonly raceRate?: number;
  /** Fake the clock the API sees (vi.setSystemTime). */
  setSystemTime(ms: number): void;
  readonly partValidator?: (clock: DvcClock) => DvcPartValidator;
  readonly frontierModel?: DvcFrontierModel;
  /** S2's recorder; defaults to the coarse table stand-in. */
  readonly recorder?: (context: { sqlite: DatabaseSync; model: SchemaModel; now: () => number }) => DependencyRecorder;
  /** A Database for the non-D1 provider; the test's getDb mock returns `env.__DVC_DB`. */
  readonly providerDatabase?: (sqlite: DatabaseSync) => Database;
  readonly parts?: readonly string[];
  readonly pages?: readonly DvcPage[];
  /** Verify every valid entry against a fresh render every N steps (1 = always); others skip entries whose read tables did not change. */
  readonly fullCheckEvery?: number;
  /**
   * Collect distinct stale-entry findings (route and the columns that changed
   * after it rendered), repair the entry and continue, instead of failing at
   * the first. `assertNoFindings()` fails with the whole list.
   */
  readonly collect?: boolean;
  /**
   * Negative control only: read the clock after the render instead of first,
   * the ordering bug §6.8 L2 rules out. The race test proves it is caught.
   */
  readonly lateClockRead?: boolean;
  readonly log?: (line: string) => void;
}

export interface DvcFinding {
  readonly signature: string;
  readonly kind: "stale-part" | "stale-page" | "trigger-divergence";
  readonly route: string;
  readonly changed: readonly string[];
  count: number;
  readonly firstReport: string;
}

interface RenderResult {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly storable: boolean;
  readonly meta: EntryMeta;
  readonly tables: ReadonlySet<string>;
  /** Row-log position before the render started. */
  readonly logPos: number;
  readonly uncacheable: readonly string[];
}

interface PartEntry {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  meta: EntryMeta;
  readonly tables: ReadonlySet<string>;
  readonly logPos: number;
  /** Row-log position at the last successful fresh comparison. */
  verifiedLogPos: number;
  verifiedAt: number;
}

interface PageEntry {
  readonly name: string;
  readonly body: string;
  readonly meta: PageEntryMeta;
  readonly rawDeps: readonly string[];
}

interface PendingRefresh {
  readonly landAtStep: number;
  readonly frontier: Frontier;
}

export interface DvcStats {
  steps: number;
  writes: number;
  mutations: number;
  mutationsRefused: number;
  curated: Record<string, number>;
  curatedRefused: number;
  timeJumps: number;
  raceInjections: number;
  partRenders: number;
  partChecks: number;
  partValidHits: number;
  partFreshComparisons: number;
  partInvalidations: number;
  partSpuriousInvalidations: number;
  invalidationReasons: Record<string, number>;
  pageReads: number;
  pageServed: number;
  pageSlow: number;
  pageRendered: number;
  frontierRefreshes: number;
  frontierRacesLanded: number;
  svReads: number;
  uncacheableRoutes: Record<string, string[]>;
  nondeterministicRoutes: string[];
  triggerCrossCheck: { compared: number; triggerOnly: number; oracleOnly: number; samples: string[] };
}

export class DvcFailure extends Error {
  constructor(message: string, readonly report: string) {
    super(`${message}\n${report}`);
    this.name = "DvcFailure";
  }
}

const RENDER_HOST = "https://api.internal";

export class DvcHarness {
  readonly stats: DvcStats = {
    steps: 0, writes: 0, mutations: 0, mutationsRefused: 0, curated: {}, curatedRefused: 0, timeJumps: 0, raceInjections: 0,
    partRenders: 0, partChecks: 0, partValidHits: 0, partFreshComparisons: 0, partInvalidations: 0, partSpuriousInvalidations: 0,
    invalidationReasons: {}, pageReads: 0, pageServed: 0, pageSlow: 0, pageRendered: 0,
    frontierRefreshes: 0, frontierRacesLanded: 0, svReads: 0, uncacheableRoutes: {}, nondeterministicRoutes: [],
    triggerCrossCheck: { compared: 0, triggerOnly: 0, oracleOnly: 0, samples: [] },
  };

  readonly partCache = new Map<string, PartEntry>();
  readonly pageCache = new Map<string, PageEntry>();
  readonly coverage = new MutationCoverage();
  readonly findings = new Map<string, DvcFinding>();
  /** Recent actions, for failure reports. */
  readonly history: string[] = [];

  now = DVC_SEED_EPOCH * 1000;
  private step = 0;
  private frontier: Frontier | null = null;
  private pending: PendingRefresh[] = [];
  /** Page bodies at each frontier's S (ground truth for G1). */
  private readonly truthAtS = new Map<number, Map<string, string>>();
  private readonly truthParts = new Map<string, { body: string; status: number; tables: ReadonlySet<string>; logPos: number; validUntil: number | null }>();
  /** Per-render context: the tables it touched and whether writes may race it. */
  private readonly capture = new AsyncLocalStorage<{ tables: Set<string>; race: boolean }>();
  /** Per-render randomness (a render that mints an id stays a pure function). */
  private readonly randomScope = new AsyncLocalStorage<Rng>();
  private suppressCapture = false;
  private injecting = false;
  /** The stream behind Math.random and crypto.getRandomValues inside the application. */
  private appRandom: Rng;
  private restoreRandomness: () => void = () => undefined;
  private readonly tableNames: ReadonlySet<string>;
  private readonly excludedParts = new Set<string>();

  private constructor(
    readonly config: DvcHarnessConfig,
    readonly sqlite: DatabaseSync,
    readonly db: Database,
    readonly env: Env,
    readonly model: SchemaModel,
    readonly rowLog: RowLog,
    readonly reference: ReferenceClock,
    readonly clock: DvcClock,
    readonly validator: DvcPartValidator,
    readonly frontierModel: DvcFrontierModel,
    readonly recorder: DependencyRecorder,
    readonly mutator: RowMutator,
    readonly rng: Rng,
    readonly parts: readonly string[],
    readonly pages: readonly DvcPage[],
  ) {
    this.appRandom = rng.fork("app");
    const names = new Set<string>(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name.toLowerCase()),
    );
    this.tableNames = names;
  }

  static async create(config: DvcHarnessConfig): Promise<DvcHarness> {
    const rng = new Rng(config.seed);
    const sqlite = createMigratedSqlite();
    let harnessNow = () => DVC_SEED_EPOCH * 1000;
    // SQL publication guards and JS deadlines must advance on the same clock.
    sqlite.function("unixepoch", () => Math.floor(harnessNow() / 1000));
    const binding = createSqliteD1Binding(sqlite);
    const seedDb = drizzle(binding, { schema }) as unknown as Database;
    config.setSystemTime(DVC_SEED_EPOCH * 1000);
    await seedDvcStore(sqlite, seedDb);
    const model = loadSchemaModel(sqlite);
    const rowLog = RowLog.install(sqlite, model);
    const reference = new ReferenceClock(sqlite, rowLog);
    reference.sync();
    const useTriggers = config.clock === "triggers" || (config.clock !== "reference" && hasTriggerClock(sqlite));
    if (config.clock === "triggers" && !hasTriggerClock(sqlite)) {
      throw new Error("DVC clock 'triggers' requested but cache_clock/cache_dep are not in the migrations (S1 not merged).");
    }
    const clock: DvcClock = useTriggers ? new TriggerClock(sqliteClockSql(sqlite)) : reference;
    const db = config.provider === "turso" && config.providerDatabase ? config.providerDatabase(sqlite) : seedDb;
    const env = {
      DB: binding,
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined, getWithMetadata: async () => ({ value: null, metadata: null }) },
      JWT_SECRET: "dvc-harness-secret-0123456789abcdef0123",
      CREDENTIAL_ENCRYPTION_KEY: "dvc-harness-credential-key-0123456789abcdef",
      ...(config.provider === "turso" ? { __DVC_DB: db } : {}),
    } as unknown as Env;
    const recorder = (config.recorder ?? ((context) => coarseTableRecorder(context.sqlite, context.model, context.now)))({
      sqlite, model, now: () => harnessNow(),
    });
    const harness = new DvcHarness(
      config, sqlite, seedDb, env, model, rowLog, reference, clock,
      (config.partValidator ?? referencePartValidator)(clock),
      config.frontierModel ?? referenceFrontierModel(),
      recorder,
      new RowMutator(sqlite, model, rng.fork("mutations")),
      rng,
      config.parts ?? dvcPartCatalogue(),
      config.pages ?? dvcPageCatalogue(),
    );
    (harness as { db: Database }).db = db;
    harnessNow = () => harness.now;
    harness.installCapture();
    harness.installRandomness();
    (harness.mutator as unknown as { coverage: MutationCoverage }).coverage = harness.coverage;
    return harness;
  }

  // -------------------------------------------------------------------------
  // Capture and rendering

  /**
   * Every statement the database executes passes through `prepare`; inside a
   * render's async context its table names are recorded (independently of
   * S2's parser), and the race mode may commit a write first.
   */
  private installCapture(): void {
    const sqlite = this.sqlite as DatabaseSync & { prepare: DatabaseSync["prepare"] };
    const original = sqlite.prepare.bind(sqlite);
    const tableNames = this.tableNames;
    sqlite.prepare = ((query: string) => {
      const context = this.suppressCapture ? undefined : this.capture.getStore();
      const observed = context?.tables;
      if (observed && this.injectPlan && !this.injecting) {
        const plan = this.injectPlan;
        if (!plan.done && plan.count === plan.at) this.runInjected(plan);
        plan.count += 1;
      }
      if (observed) {
        for (const match of query.matchAll(/"([^"]+)"|`([^`]+)`|\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
          const name = (match[1] ?? match[2] ?? match[3] ?? "").toLowerCase();
          if (tableNames.has(name)) observed.add(name);
        }
        if (context!.race && !this.injecting && (this.config.raceRate ?? 0) > 0 && !sqlite.isTransaction && this.rng.chance(this.config.raceRate!)) {
          this.injectRaceWrite();
        }
      }
      return original(query);
    }) as DatabaseSync["prepare"];
  }

  /**
   * Application randomness (ids minted by services, or by a render) comes from
   * a seeded stream: writes draw from the walk's stream, and every render
   * restarts a stream derived from its path, so a render that mints an id is
   * still a pure function of the database, the time and the path.
   */
  private installRandomness(): void {
    const random = Math.random;
    const cryptoObject = globalThis.crypto as Crypto & { getRandomValues: Crypto["getRandomValues"]; randomUUID: Crypto["randomUUID"] };
    const getRandomValues = cryptoObject.getRandomValues;
    const randomUUID = cryptoObject.randomUUID;
    const stream = () => this.randomScope.getStore() ?? this.appRandom;
    Math.random = () => stream().next();
    cryptoObject.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
      if (array) stream().fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      return array;
    }) as Crypto["getRandomValues"];
    cryptoObject.randomUUID = (() => {
      const hex = Array.from({ length: 32 }, () => Math.floor(stream().next() * 16).toString(16)).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }) as Crypto["randomUUID"];
    this.restoreRandomness = () => {
      Math.random = random;
      cryptoObject.getRandomValues = getRandomValues;
      cryptoObject.randomUUID = randomUUID;
    };
  }

  private injectPlan: { at: number; count: number; done: boolean; write: (sqlite: DatabaseSync) => void } | null = null;

  private runInjected(plan: NonNullable<DvcHarness["injectPlan"]>): void {
    this.injecting = true;
    this.suppressCapture = true;
    try {
      plan.write(this.sqlite);
      plan.done = true;
    } finally {
      this.suppressCapture = false;
      this.injecting = false;
    }
  }

  /**
   * Race test primitive (§7 item 4): render `path` and commit `write` after
   * the render's clock read, just before its statement number `at` (0 = before
   * the first data read). An `at` past the last statement commits between the
   * render and the cache put. The result is stored as a miss would be.
   */
  async renderWithCommit(path: string, at: number, write: (sqlite: DatabaseSync) => void): Promise<{ statements: number; injected: boolean }> {
    const plan = { at, count: 0, done: false, write };
    this.injectPlan = plan;
    let result: RenderResult;
    try {
      result = await this.render(path);
    } finally {
      this.injectPlan = null;
    }
    const statements = plan.count;
    if (!plan.done) this.runInjected(plan);
    this.store(result);
    return { statements, injected: plan.done };
  }

  /** Validate one cached part now: the verdict, and whether its body equals a fresh render. */
  async checkPart(path: string): Promise<{ cached: boolean; valid: boolean; equal: boolean }> {
    const entry = this.partCache.get(path);
    if (!entry) return { cached: false, valid: false, equal: false };
    const [verdict] = await this.validator.validate([entry.meta], this.now);
    const fresh = await this.render(path);
    return { cached: true, valid: verdict!.valid, equal: fresh.body === entry.body && fresh.status === entry.status };
  }

  /** Fill the part cache with these reads concurrently (race mode interleaves writes). */
  async readPartsConcurrently(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => {
      const result = await this.render(path, true);
      this.store(result);
    }));
  }

  /** Advance simulated time without verifying. */
  tick(ms: number): void {
    this.now += ms;
  }

  private injectRaceWrite(): void {
    this.injecting = true;
    this.suppressCapture = true;
    try {
      const mutation = this.mutator.random();
      if (mutation) {
        this.stats.raceInjections += 1;
        this.remember(`race-write during render: ${mutation.description}`);
      }
    } finally {
      this.suppressCapture = false;
      this.injecting = false;
    }
  }

  private ctx(): { ctx: ExecutionContext; settle: () => Promise<void> } {
    const waits: Promise<unknown>[] = [];
    return {
      ctx: { waitUntil: (promise: Promise<unknown>) => void waits.push(promise.catch(() => undefined)), passThroughOnException: () => undefined } as unknown as ExecutionContext,
      settle: async () => {
        await Promise.all(waits);
      },
    };
  }

  /** Render one part as the API part cache would on a miss. */
  async render(path: string, allowRace = false): Promise<RenderResult> {
    this.config.setSystemTime(this.now);
    if (process.env.DVC_DEBUG) (this.config.log ?? console.error)(`[render] ${path}`);
    const logPos = this.rowLog.position();
    const s0 = await this.clock.current();
    const observed = new Set<string>();
    const { ctx, settle } = this.ctx();
    const request = new Request(`${RENDER_HOST}${path}`, { headers: { Accept: "application/json" } });
    const recordedRender = await this.randomScope.run(new Rng(`render:${path}`), () => this.recorder.record(
        path,
        () => this.capture.run({ tables: observed, race: allowRace }, async () => {
          const rendered = await renderPublicRead(request, this.env, ctx);
          // Read the body before settling waitUntil work: that work reads a tee of it.
          const text = await rendered.text();
          await settle();
          return new Response(text, { status: rendered.status, headers: rendered.headers });
        }),
        observed,
      ));
    const { response, dependencies } = recordedRender;
    const s0Used = this.config.lateClockRead ? await this.clock.current() : s0;
    const body = await response.text();
    const fromHeaders = headerDependencies(response);
    const recorded: RecordedDependencies = fromHeaders ?? dependencies;
    this.stats.partRenders += 1;
    const storable = response.status === 200
      && (response.headers.get("Cache-Control") ?? "") === "public, max-age=0, no-cache, must-revalidate"
      && !response.headers.has("Set-Cookie")
      && recorded.uncacheable.length === 0;
    if (recorded.uncacheable.length > 0) this.stats.uncacheableRoutes[path] = [...recorded.uncacheable];
    return {
      path,
      status: response.status,
      body,
      storable,
      meta: {
        apiVersion: DVC_API_VERSION,
        s0: recorded.s0 ?? s0Used,
        deps: recorded.deps.includes("store") ? recorded.deps : [...recorded.deps, "store"],
        validUntil: recorded.validUntil,
        softMaxAgeSeconds: recorded.softMaxAgeSeconds,
        renderedAt: this.now,
      },
      tables: observed,
      logPos,
      uncacheable: recorded.uncacheable,
    };
  }

  private store(result: RenderResult): void {
    if (!result.storable || this.excludedParts.has(result.path)) {
      this.partCache.delete(result.path);
      return;
    }
    this.partCache.set(result.path, {
      path: result.path,
      status: result.status,
      body: result.body,
      meta: result.meta,
      tables: result.tables,
      logPos: result.logPos,
      verifiedLogPos: result.logPos,
      verifiedAt: this.now,
    });
  }

  /** Read a part through the cache (a storefront batch part). */
  async readPart(path: string): Promise<{ status: number; body: string; meta: EntryMeta }> {
    const entry = this.partCache.get(path);
    if (entry) {
      const [verdict] = await this.validator.validate([entry.meta], this.now);
      if (verdict!.valid) {
        entry.meta = { ...entry.meta, s0: verdict!.s0 };
        return { status: entry.status, body: entry.body, meta: entry.meta };
      }
    }
    const result = await this.render(path, true);
    this.store(result);
    return { status: result.status, body: result.body, meta: result.meta };
  }

  // -------------------------------------------------------------------------
  // Setup

  /** Fill the part cache and drop routes whose output is not a function of the database and time. */
  async warm(): Promise<void> {
    for (const path of this.parts) {
      const first = await this.render(path);
      const second = await this.render(path);
      if (first.body !== second.body || first.status !== second.status) {
        this.stats.nondeterministicRoutes.push(path);
        this.excludedParts.add(path);
        continue;
      }
      this.store(second);
    }
  }

  /** Parts that did not answer 200 on the seeded store (a catalogue problem, reported by the test). */
  nonOkParts(): string[] {
    return this.parts.filter((path) => !this.partCache.has(path) && !this.excludedParts.has(path) && !this.stats.uncacheableRoutes[path]);
  }

  // -------------------------------------------------------------------------
  // Verification

  /**
   * Validate every cached part. Valid entries must equal a fresh render
   * (skipped only when none of the tables the entry read changed since it
   * was last proven equal, and this is not a full check); invalid entries are
   * re-rendered and counted.
   */
  async verifyParts(full: boolean): Promise<void> {
    const entries = [...this.partCache.values()];
    if (entries.length === 0) return;
    const verdicts = await this.validator.validate(entries.map((entry) => entry.meta), this.now);
    this.stats.partChecks += entries.length;
    const logNow = this.rowLog.position();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const verdict = verdicts[index]!;
      if (verdict.valid) {
        this.stats.partValidHits += 1;
        entry.meta = { ...entry.meta, s0: verdict.s0 };
        const changedTables = this.rowLog.tablesChangedSince(entry.verifiedLogPos);
        const touched = [...entry.tables].some((table) => changedTables.has(table));
        if (!full && !touched) continue;
        const fresh = await this.render(entry.path);
        this.stats.partFreshComparisons += 1;
        if (fresh.body === entry.body && fresh.status === entry.status) {
          entry.verifiedLogPos = fresh.logPos;
          entry.verifiedAt = this.now;
          continue;
        }
        const failure = this.staleFailure(entry, fresh);
        if (!this.config.collect) throw failure;
        this.recordFinding("stale-part", entry.path, await this.culprits(entry), failure.report);
        this.store(fresh);
        continue;
      }
      this.stats.partInvalidations += 1;
      this.stats.invalidationReasons[verdict.reason] = (this.stats.invalidationReasons[verdict.reason] ?? 0) + 1;
      const fresh = await this.render(entry.path);
      if (fresh.body === entry.body && fresh.status === entry.status) this.stats.partSpuriousInvalidations += 1;
      this.store(fresh);
    }
    void logNow;
  }

  /**
   * Render `path` on a copy of the database with `changes` undone (newest
   * first), except the one candidate `keep` names: an update column kept at
   * its new value (`table.column`) or an insert/delete left in place
   * (`table:op`). The copy has no triggers, so guards cannot refuse the undo.
   */
  private async renderOnRevertedCopy(path: string, changes: readonly LoggedChange[], keep?: string): Promise<{ status: number; body: string }> {
    const image = (this.sqlite as DatabaseSync & { serialize(): Uint8Array }).serialize();
    const copy = new DatabaseSync(":memory:") as DatabaseSync & { deserialize(image: Uint8Array): void };
    copy.deserialize(image);
    copy.function("unixepoch", () => Math.floor(this.now / 1000));
    copy.exec("PRAGMA foreign_keys = OFF");
    for (const { name } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) {
      copy.exec(`DROP TRIGGER "${name}"`);
    }
    for (const change of [...changes].reverse()) {
      if (keep === `${change.table}:${change.op}`) continue;
      const table = this.model.get(change.table)!;
      const keyColumns = table.pkColumns.length > 0 ? table.pkColumns : table.columns.map((column) => column.name);
      const keyOf = (row: Readonly<Record<string, unknown>>) => keyColumns.map((column) => row[column] as SQLInputValue);
      const where = keyColumns.map((column) => `"${column}" = ?`).join(" AND ");
      if (change.op === "insert") copy.prepare(`DELETE FROM "${change.table}" WHERE ${where}`).run(...keyOf(change.new!));
      if (change.op === "delete" || change.op === "update") {
        if (change.op === "update") copy.prepare(`DELETE FROM "${change.table}" WHERE ${where}`).run(...keyOf(change.new!));
        const columns = Object.keys(change.old!);
        const restored = columns.map((column) => (change.op === "update" && keep === `${change.table}.${column}` ? change.new![column] : change.old![column]) as SQLInputValue);
        copy.prepare(`INSERT INTO "${change.table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .run(...restored);
      }
    }
    const env = { ...(this.env as unknown as Record<string, unknown>), DB: createSqliteD1Binding(copy) } as unknown as Env;
    delete (env as unknown as Record<string, unknown>).__DVC_DB;
    const { ctx, settle } = this.ctx();
    this.config.setSystemTime(this.now);
    const { response, body } = await this.randomScope.run(new Rng(`render:${path}`), async () => {
      const rendered = await renderPublicRead(new Request(`${RENDER_HOST}${path}`, { headers: { Accept: "application/json" } }), env, ctx);
      const text = await rendered.text();
      await settle();
      return { response: rendered, body: text };
    });
    copy.close();
    return { status: response.status, body };
  }

  /** `table.column` (or `table:insert`/`table:delete`) changed after `logPos`, in `tables`. */
  private changedColumnsSince(logPos: number, tables: ReadonlySet<string>): string[] {
    const changed = new Set<string>();
    for (const change of this.rowLog.since(logPos)) {
      if (!tables.has(change.table)) continue;
      if (change.op !== "update") {
        changed.add(`${change.table}:${change.op}`);
        continue;
      }
      for (const column of Object.keys(change.new!)) {
        if (String(change.new![column]) !== String(change.old![column])) changed.add(`${change.table}.${column}`);
      }
    }
    return [...changed].sort();
  }

  /**
   * Which of the changes since the entry rendered make the difference: each
   * candidate alone is applied on top of the entry's state (all others
   * undone); a candidate whose render differs from the entry is a culprit.
   */
  private async culprits(entry: PartEntry): Promise<string[]> {
    const changes = this.rowLog.since(entry.logPos);
    const candidates = this.changedColumnsSince(entry.logPos, entry.tables);
    const found: string[] = [];
    for (const candidate of candidates) {
      let alone: { status: number; body: string };
      try {
        alone = await this.renderOnRevertedCopy(entry.path, changes, candidate);
      } catch {
        // The candidate alone is not a valid row (a CHECK couples it to a
        // column the undo restored): it cannot be isolated.
        continue;
      }
      if (alone.body !== entry.body || alone.status !== entry.status) found.push(candidate);
    }
    return found.length > 0 ? found : candidates.map((candidate) => `${candidate}?`);
  }

  private recordFinding(kind: DvcFinding["kind"], route: string, changed: readonly string[], report: string): void {
    const family = route.split("?")[0]!;
    const signature = `${kind} ${family} <- ${changed.join(" ")}`;
    const known = this.findings.get(signature);
    if (known) {
      known.count += 1;
      return;
    }
    this.findings.set(signature, { signature, kind, route, changed, count: 1, firstReport: report });
    this.config.log?.(`[DVC finding] ${signature}`);
  }

  /** Fail with every distinct finding of a collecting run. */
  assertNoFindings(): void {
    if (this.findings.size === 0) return;
    const list = [...this.findings.values()]
      .sort((a, b) => b.count - a.count)
      .map((finding) => `- (${finding.count}x) ${finding.signature}`);
    const first = [...this.findings.values()][0]!;
    throw new DvcFailure(`[DVC] ${this.findings.size} distinct stale-entry findings`, `${list.join("\n")}\n\nfirst report:\n${first.firstReport}`);
  }

  private staleFailure(entry: PartEntry, fresh: RenderResult): DvcFailure {
    const changes = this.rowLog.since(entry.logPos);
    const relevant = changes.filter((change) => entry.tables.has(change.table));
    const describe = (change: LoggedChange) => {
      const image = change.new ?? change.old ?? {};
      const table = this.model.get(change.table);
      const key = (table?.pkColumns ?? []).map((column) => `${column}=${String(image[column])}`).join(",");
      if (change.op !== "update") return `  ${change.op} ${change.table} ${key}`;
      const columns = Object.keys(change.new!).filter((column) => String(change.new![column]) !== String(change.old![column]));
      return `  update ${change.table} ${key} changed ${columns.map((column) => `${column}: ${clip(String(change.old![column]))} -> ${clip(String(change.new![column]))}`).join("; ")}`;
    };
    const report = [
      `seed=${this.config.seed} step=${this.step} clock=${this.clock.name} validator=${this.validator.name} recorder=${this.recorder.name}`,
      `route ${entry.path} (read tables: ${[...entry.tables].sort().join(", ")})`,
      `entry s0=${entry.meta.s0} renderedAt=${entry.meta.renderedAt} now=${this.now} validUntil=${entry.meta.validUntil} soft=${entry.meta.softMaxAgeSeconds}`,
      `entry keys (${entry.meta.deps.length}): ${entry.meta.deps.slice(0, 60).join(" ")}`,
      `rows changed after the entry rendered, in tables it read (${relevant.length} of ${changes.length}):`,
      ...relevant.slice(-25).map(describe),
      `keys the reference oracle advanced since then: ${[...this.reference.keysFor(changes)].sort().slice(0, 80).join(" ")}`,
      `first difference: ${firstDifference(entry.body, fresh.body)}`,
      "recent actions:",
      ...this.history.slice(-15).map((line) => `  ${line}`),
      `replay: DVC_SEED=${this.config.seed} DVC_STEPS=${this.step + 1}`,
    ].join("\n");
    return new DvcFailure(`[DVC] stale entry served as valid: ${entry.path}`, report);
  }

  // -------------------------------------------------------------------------
  // Storefront pages and the frontier

  private truthFor(S: number): Map<string, string> | undefined {
    return this.truthAtS.get(S);
  }

  /** Page bodies at the current clock, reusing part renders whose tables did not change. */
  private async snapshotTruth(): Promise<Map<string, string>> {
    const needed = new Set(this.pages.flatMap((page) => page.parts));
    for (const path of needed) {
      const known = this.truthParts.get(path);
      if (known && (known.validUntil === null || this.now < known.validUntil)) {
        const changed = this.rowLog.tablesChangedSince(known.logPos);
        if (![...known.tables].some((table) => changed.has(table))) continue;
      }
      const result = await this.render(path);
      this.truthParts.set(path, { body: result.body, status: result.status, tables: result.tables, logPos: result.logPos, validUntil: result.meta.validUntil });
    }
    const pages = new Map<string, string>();
    for (const page of this.pages) {
      pages.set(page.name, composePage(page.parts.map((path) => this.truthParts.get(path)!)));
    }
    return pages;
  }

  /**
   * One frontier refresh as a storefront isolate performs it: read the delta
   * since the frontier it holds (looping while the API caps the delta), merge,
   * and put. Returns the object it would store.
   */
  private async fetchFrontier(base: Frontier | null): Promise<Frontier> {
    const cap = this.config.frontierCap ?? 4000;
    const limit = this.config.frontierDeltaLimit ?? 4000;
    const sentAt = this.now;
    const clockAtSend = await this.clock.current();
    let merged = base;
    let since: number | null = base ? base.S : null;
    for (let round = 0; round < 16; round += 1) {
      const delta = await this.clock.frontierDelta(since, limit);
      merged = this.frontierModel.merge(merged, delta, sentAt, cap);
      if (merged.S >= clockAtSend) break;
      since = merged.S;
    }
    if (merged!.S < clockAtSend) {
      // Could not catch up: claim nothing older than the clock (every older entry takes the slow path).
      merged = { apiVersion: DVC_API_VERSION, sentAt, S: clockAtSend, horizon: clockAtSend, floor: merged!.floor, changes: new Map() };
    }
    this.stats.frontierRefreshes += 1;
    if (!this.truthAtS.has(merged!.S)) this.truthAtS.set(merged!.S, await this.snapshotTruth());
    return merged!;
  }

  private gcTruth(): void {
    const live = new Set<number>([...(this.frontier ? [this.frontier.S] : []), ...this.pending.map((each) => each.frontier.S)]);
    for (const S of this.truthAtS.keys()) if (!live.has(S)) this.truthAtS.delete(S);
  }

  /** Land racing refreshes due now, in their (possibly out-of-order) sequence. */
  private landRefreshes(): void {
    const due = this.pending.filter((each) => each.landAtStep <= this.step);
    this.pending = this.pending.filter((each) => each.landAtStep > this.step);
    for (const refresh of this.rng.sample(due, due.length)) {
      this.frontier = refresh.frontier;
      this.stats.frontierRacesLanded += 1;
    }
    this.gcTruth();
  }

  private async ensureFrontier(sv: number | null): Promise<Frontier> {
    const delta = this.config.deltaMs ?? 1000;
    const stale = !this.frontier || this.now - this.frontier.sentAt > delta;
    if (stale || (sv !== null && this.frontier!.S < sv)) {
      this.frontier = await this.fetchFrontier(this.frontier);
      this.gcTruth();
    } else if (this.now - this.frontier!.sentAt > delta / 2 && this.pending.length < 3) {
      // Refresh-ahead: lands later, possibly after a newer one (claims less, never more).
      const refresh = await this.fetchFrontier(this.frontier);
      this.pending.push({ landAtStep: this.step + this.rng.int(0, 3), frontier: refresh });
      if (this.rng.chance(0.3)) {
        const racer = await this.fetchFrontier(this.frontier);
        this.pending.push({ landAtStep: this.step + this.rng.int(0, 3), frontier: racer });
      }
    }
    return this.frontier!;
  }

  private async renderPage(page: DvcPage): Promise<PageEntry> {
    const results = [];
    for (const path of page.parts) results.push(await this.readPart(path));
    const rawDeps = [...new Set(results.flatMap((result) => result.meta.deps))].sort();
    const validUntils = results.map((result) => result.meta.validUntil).filter((value): value is number => value !== null);
    const softs = results.map((result) => result.meta.softMaxAgeSeconds).filter((value): value is number => value !== null);
    const renderedAt = Math.min(...results.map((result) => result.meta.renderedAt));
    return {
      name: page.name,
      body: composePage(results),
      rawDeps,
      meta: {
        apiVersion: DVC_API_VERSION,
        s0: Math.min(...results.map((result) => result.meta.s0)),
        depHashes: rawDeps.map((dep) => this.frontierModel.hashDep(dep)),
        validUntil: validUntils.length > 0 ? Math.min(...validUntils) : null,
        softMaxAgeSeconds: softs.length > 0 ? Math.min(...softs) : null,
        renderedAt,
      },
    };
  }

  /** One storefront page view in this data center. `sv` is the read-your-writes token (§6.10). */
  async readPage(page: DvcPage, sv: number | null = null): Promise<"serve" | "slow" | "render"> {
    this.stats.pageReads += 1;
    if (sv !== null) this.stats.svReads += 1;
    const frontier = await this.ensureFrontier(sv);
    const entry = this.pageCache.get(page.name);
    if (!entry) {
      this.pageCache.set(page.name, await this.renderPage(page));
      this.stats.pageRendered += 1;
      return "render";
    }
    const decision = this.frontierModel.decide(entry.meta, frontier, this.now);
    if (decision === "serve") {
      try {
        await this.assertPageServe(page, entry, frontier, sv);
      } catch (error) {
        if (!this.config.collect || !(error instanceof DvcFailure)) throw error;
        this.recordFinding("stale-page", page.name, [error.message.replace(/^\[DVC\] /, "").slice(0, 160)], error.report);
        this.pageCache.set(page.name, await this.renderPage(page));
        return "render";
      }
      this.stats.pageServed += 1;
      return "serve";
    }
    if (decision === "slow") {
      const [verdict] = await this.validator.validate([{ ...entry.meta, deps: entry.rawDeps }], this.now);
      if (verdict!.valid) {
        const fresh = await this.freshPage(page);
        if (fresh !== entry.body) {
          throw new DvcFailure(`[DVC] slow-path page served stale: ${page.name}`, this.pageReport(page, entry, frontier, fresh));
        }
        this.pageCache.set(page.name, { ...entry, meta: { ...entry.meta, s0: verdict!.s0 } });
        this.stats.pageSlow += 1;
        return "slow";
      }
    }
    this.pageCache.set(page.name, await this.renderPage(page));
    this.stats.pageRendered += 1;
    return "render";
  }

  private async freshPage(page: DvcPage): Promise<string> {
    const results = [];
    for (const path of page.parts) results.push(await this.render(path));
    return composePage(results);
  }

  /** G1 at a page hit (CACHE-DESIGN §6.8). */
  private async assertPageServe(page: DvcPage, entry: PageEntry, frontier: Frontier, sv: number | null): Promise<void> {
    const delta = this.config.deltaMs ?? 1000;
    const fail = (why: string, fresh?: string) => new DvcFailure(`[DVC] page hit violates G1 (${why}): ${page.name}`, this.pageReport(page, entry, frontier, fresh));
    if (this.now - frontier.sentAt > delta) throw fail("frontier older than Δ");
    if (sv !== null && frontier.S < sv) throw fail("read-your-writes token newer than the frontier");
    if (entry.meta.validUntil !== null && this.now >= entry.meta.validUntil) throw fail("served at or after validUntil");
    if (entry.meta.s0 >= frontier.S) return;
    // Ground truth: no dependency changed in (s0, F.S].
    const { changed } = await this.clock.changedSince(entry.rawDeps, entry.meta.s0);
    const missed = [...changed.entries()].filter(([, seq]) => seq <= frontier.S);
    if (missed.length > 0) throw fail(`dependencies changed in (s0, F.S]: ${missed.map(([dep, seq]) => `${dep}@${seq}`).join(" ")}`);
    const truth = this.truthFor(frontier.S)?.get(page.name);
    if (truth !== undefined && truth !== entry.body) throw fail("body differs from the page at F.S", truth);
  }

  private pageReport(page: DvcPage, entry: PageEntry, frontier: Frontier, fresh?: string): string {
    return [
      `seed=${this.config.seed} step=${this.step} now=${this.now} frontier=${this.frontierModel.name}`,
      `page ${page.name} parts: ${page.parts.join(" ")}`,
      `entry s0=${entry.meta.s0} renderedAt=${entry.meta.renderedAt} validUntil=${entry.meta.validUntil} keys=${entry.rawDeps.length}`,
      `frontier sentAt=${frontier.sentAt} S=${frontier.S} horizon=${frontier.horizon} floor=${frontier.floor} changes=${frontier.changes.size}`,
      fresh === undefined ? "" : `first difference: ${firstDifference(entry.body, fresh)}`,
      "recent actions:",
      ...this.history.slice(-15).map((line) => `  ${line}`),
      `replay: DVC_SEED=${this.config.seed} DVC_STEPS=${this.step + 1}`,
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Writes

  private remember(line: string): void {
    this.history.push(`#${this.step} t=${this.now - DVC_SEED_EPOCH * 1000}ms ${line}`);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  /** Apply one write; returns the clock after it (the `_sv` a merchant would carry). */
  async write(kind: "mutation" | "curated" | "time" | "band" | "tree" | "json"): Promise<number | null> {
    this.config.setSystemTime(this.now);
    const before = this.rowLog.position();
    const triggerBefore = this.clock.name === "triggers" ? await this.clock.current() : 0;
    let wrote = false;
    let singleStatement = kind === "band" || kind === "tree" || kind === "json";
    if (kind === "mutation") {
      const count = this.rng.weighted([[6, 1], [3, 2], [1, 3]]);
      singleStatement = count === 1;
      for (let index = 0; index < count; index += 1) {
        const mutation = this.mutator.random();
        if (mutation) {
          this.stats.mutations += 1;
          this.remember(mutation.description);
          wrote = true;
        } else {
          this.stats.mutationsRefused += 1;
        }
      }
    } else if (kind === "curated") {
      const action = this.rng.weighted(CURATED_ACTIONS.map((each) => [each.weight, each] as const)) as CuratedAction;
      try {
        const description = await action.run({ sqlite: this.sqlite, db: this.db, rng: this.rng });
        if (description) {
          this.stats.curated[action.name] = (this.stats.curated[action.name] ?? 0) + 1;
          this.remember(description);
          wrote = true;
        }
      } catch (error) {
        this.stats.curatedRefused += 1;
        this.remember(`${action.name} refused: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    } else if (kind === "band") {
      wrote = this.bandWalk();
    } else if (kind === "tree") {
      const mutation = this.mutator.update("categories", "parent_id");
      if (mutation) {
        this.remember(mutation.description);
        wrote = true;
      }
    } else if (kind === "json") {
      const target = this.rng.pick([
        ["settings", "value"], ["theme_settings", "colors"], ["collections", "config"], ["hero_sliders", "images"],
        ["promotion_effects", "config"], ["checkout_languages", "language_data"], ["analytics", "config"], ["product_content_blocks", "settings"],
      ] as const);
      const mutation = this.mutator.update(target[0], target[1]);
      if (mutation) {
        this.remember(mutation.description);
        wrote = true;
      }
    } else if (kind === "time") {
      this.timeJump();
      return null;
    }
    if (!wrote) return null;
    this.stats.writes += 1;
    const changes = this.rowLog.since(before);
    if (this.clock.name === "triggers") await this.crossCheckTriggers(changes, triggerBefore, singleStatement);
    return this.clock.current();
  }

  /** Move one SKU's stock across its band edges (0, low level, above). */
  private bandWalk(): boolean {
    const variants = this.sqlite.prepare(
      "SELECT id, stock, reserved_stock AS reserved, coalesce(low_stock_threshold, 2) AS low FROM product_variants",
    ).all() as Array<{ id: string; stock: number; reserved: number; low: number }>;
    if (variants.length === 0) return false;
    const variant = this.rng.pick(variants);
    const target = this.rng.pick([0, 1, Number(variant.low), Number(variant.low) + 1, 50]) + Number(variant.reserved);
    const noise = this.rng.chance(0.3);
    this.sqlite.prepare("UPDATE product_variants SET stock = ?, stock_version = stock_version + 1 WHERE id = ?").run(noise ? Number(variant.stock) + 1 : target, variant.id);
    this.remember(`band walk ${variant.id} stock ${variant.stock} -> ${noise ? Number(variant.stock) + 1 : target}`);
    return true;
  }

  private timeJump(): void {
    const boundaries = (this.sqlite.prepare(
      "SELECT starts_at AS t FROM promotions WHERE starts_at IS NOT NULL UNION SELECT ends_at FROM promotions WHERE ends_at IS NOT NULL",
    ).all() as Array<{ t: number }>).map((row) => Number(row.t) * 1000).filter((t) => t > this.now);
    const target = boundaries.length > 0 && this.rng.chance(0.7)
      ? this.rng.pick(boundaries) + this.rng.pick([-1, 0, 1, 1500])
      : this.now + this.rng.pick([1500, 5000, 60_000, 700_000]);
    if (target <= this.now) return;
    this.remember(`time jump +${target - this.now}ms`);
    this.now = target;
    this.stats.timeJumps += 1;
  }

  /**
   * With S1's triggers as the clock, compare the keys they advanced with the
   * reference oracle's reading of the registry for the same row changes.
   */
  private async crossCheckTriggers(changes: readonly LoggedChange[], before: number, singleStatement = false): Promise<void> {
    const oracle = this.reference.keysFor(changes);
    const rows = this.sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(before) as Array<{ dep: string }>;
    const triggers = new Set(rows.map((row) => row.dep));
    const check = this.stats.triggerCrossCheck;
    check.compared += 1;
    if (triggers.has("store")) return;
    const oracleOnly = [...oracle].filter((key) => !triggers.has(key));
    const triggerOnly = [...triggers].filter((key) => !oracle.has(key));
    check.oracleOnly += oracleOnly.length;
    check.triggerOnly += triggerOnly.length;
    const describe = () => changes.slice(0, 4).map((change) => `${change.op} ${change.table}${change.op === "update" ? `(${Object.keys(change.new!).filter((column) => String(change.new![column]) !== String(change.old![column])).join(",")})` : ""}`).join(", ");
    if (oracleOnly.length > 0 && check.samples.length < 30) {
      check.samples.push(`#${this.step} oracle-only ${oracleOnly.slice(0, 8).join(" ")} for ${describe()}`);
    }
    if (triggerOnly.length > 0 && check.samples.length < 30) {
      check.samples.push(`#${this.step} trigger-only ${triggerOnly.slice(0, 8).join(" ")} for ${describe()}`);
    }
    // One raw statement: the oracle reads the same state the triggers did, so
    // the key sets must be equal. (Multi-statement service batches can differ
    // in lookup timing; those stay diagnostics.)
    if (singleStatement && (oracleOnly.length > 0 || triggerOnly.length > 0)) {
      const report = `oracle-only: ${oracleOnly.join(" ") || "-"}\ntrigger-only: ${triggerOnly.join(" ") || "-"}\nchanges: ${describe()}\nseed=${this.config.seed} step=${this.step}`;
      if (!this.config.collect) throw new DvcFailure("[DVC] generated triggers and the registry oracle disagree", report);
      this.recordFinding("trigger-divergence", changes[0]?.table ?? "?", [...oracleOnly.map((key) => `-${key}`), ...triggerOnly.map((key) => `+${key}`)].slice(0, 12), report);
    }
  }

  // -------------------------------------------------------------------------
  // The walk

  /** One step: an action, time passing, verification, page views. */
  private coveredLogPos = 0;

  /** Coverage counts every committed row change in the log, not only the generator's own. */
  private absorbCoverage(): void {
    const changes = this.rowLog.since(this.coveredLogPos);
    for (const change of changes) this.coverage.recordChange(change);
    if (changes.length > 0) this.coveredLogPos = changes[changes.length - 1]!.id;
  }

  async runStep(): Promise<void> {
    this.step += 1;
    this.stats.steps += 1;
    this.landRefreshes();
    const action = this.rng.weighted<"mutation" | "curated" | "time" | "band" | "tree" | "json" | "read">([
      [40, "mutation"], [15, "curated"], [6, "band"], [4, "tree"], [8, "json"], [4, "time"], [23, "read"],
    ]);
    const sv = action === "read" ? null : await this.write(action);
    this.now += this.rng.weighted([[5, this.rng.int(0, 300)], [3, this.rng.int(300, 1200)], [1, this.rng.int(1200, 4000)]]);
    const every = this.config.fullCheckEvery ?? 1;
    await this.verifyParts(every <= 1 || this.step % every === 0 || action === "time");
    const views = this.rng.int(1, 4);
    for (let index = 0; index < views; index += 1) {
      await this.readPage(this.rng.pick(this.pages), index === 0 && sv !== null && this.rng.chance(0.5) ? sv : null);
    }
    this.absorbCoverage();
    if (this.step % 500 === 0) this.rowLog.trim(Math.min(...[...this.partCache.values()].map((entry) => entry.logPos), ...[...this.truthParts.values()].map((entry) => entry.logPos)) - 1);
  }

  /**
   * The coverage sweep: every column of every registered table updated once,
   * and one insert and one delete per registered table, each followed by a
   * full verification. Bounded, deterministic coverage before the random walk.
   */
  async sweep(): Promise<void> {
    // Trigger-owned tables change only through the writes that own them.
    const tables = [...this.model.values()].filter((table) => table.registered && !TRIGGER_OWNED_TABLES.has(table.name));
    for (const table of tables) {
      const plan: Array<() => Mutation | null> = [];
      for (const column of table.columns) {
        if (column.pk > 0 && table.pkColumns.length === 1) continue;
        plan.push(() => this.mutator.update(table.name, column.name));
      }
      plan.push(() => this.mutator.insert(table.name));
      plan.push(() => this.mutator.delete(table.name));
      for (const apply of plan) {
        this.step += 1;
        this.stats.steps += 1;
        this.config.setSystemTime(this.now);
        const before = this.rowLog.position();
        const triggerBefore = this.clock.name === "triggers" ? await this.clock.current() : 0;
        const mutation = apply();
        if (!mutation) {
          this.stats.mutationsRefused += 1;
          continue;
        }
        this.stats.mutations += 1;
        this.stats.writes += 1;
        this.remember(`sweep ${mutation.description}`);
        if (this.clock.name === "triggers") await this.crossCheckTriggers(this.rowLog.since(before), triggerBefore, true);
        this.now += 250;
        await this.verifyParts(false);
        this.absorbCoverage();
      }
    }
    // Second pass: columns a single attempt could not change (a CHECK couples
    // them to other columns) get more attempts with companions.
    for (let pass = 0; pass < 3; pass += 1) {
      const { columns } = this.coverage.gaps(this.model);
      if (columns.length === 0) break;
      for (const gap of columns) {
        const [table, column] = gap.split(".") as [string, string];
        this.step += 1;
        this.stats.steps += 1;
        this.config.setSystemTime(this.now);
        const mutation = this.mutator.update(table, column);
        if (!mutation) continue;
        this.stats.mutations += 1;
        this.stats.writes += 1;
        this.remember(`sweep ${mutation.description}`);
        this.now += 250;
        await this.verifyParts(false);
        this.absorbCoverage();
      }
    }
  }

  /** The promotion boundaries of the seed, for the scheduled-time scenario. */
  static promotionBoundariesMs(): number[] {
    return DVC_IDS.promotionBoundaries.map((seconds) => seconds * 1000);
  }

  /** Advance simulated time to `ms` (a scheduled boundary) and verify everything. */
  async advanceTo(ms: number): Promise<void> {
    this.step += 1;
    this.remember(`advance to +${ms - DVC_SEED_EPOCH * 1000}ms`);
    this.now = ms;
    await this.verifyParts(true);
  }

  summary(): string {
    const s = this.stats;
    const gaps = this.coverage.gaps(this.model);
    return [
      `seed=${this.config.seed} clock=${this.clock.name} validator=${this.validator.name} recorder=${this.recorder.name} frontier=${this.frontierModel.name}`,
      `steps=${s.steps} writes=${s.writes} mutations=${s.mutations} refused=${s.mutationsRefused} curated=${JSON.stringify(s.curated)} curatedRefused=${s.curatedRefused} timeJumps=${s.timeJumps} raceInjections=${s.raceInjections}`,
      `parts: renders=${s.partRenders} checks=${s.partChecks} validHits=${s.partValidHits} freshComparisons=${s.partFreshComparisons} invalidations=${s.partInvalidations} spurious=${s.partSpuriousInvalidations} reasons=${JSON.stringify(s.invalidationReasons)}`,
      `pages: reads=${s.pageReads} served=${s.pageServed} slow=${s.pageSlow} rendered=${s.pageRendered} frontierRefreshes=${s.frontierRefreshes} racesLanded=${s.frontierRacesLanded} svReads=${s.svReads}`,
      `precision: spurious invalidations per write=${s.writes > 0 ? (s.partSpuriousInvalidations / s.writes).toFixed(2) : "n/a"}; hit ratio (validated)=${s.partChecks > 0 ? (s.partValidHits / s.partChecks).toFixed(3) : "n/a"}`,
      `coverage gaps: ops=${gaps.ops.length} columns=${gaps.columns.length}`,
      `uncacheable routes: ${Object.keys(s.uncacheableRoutes).length}; nondeterministic: ${s.nondeterministicRoutes.join(" ") || "none"}`,
      s.triggerCrossCheck.compared > 0 ? `trigger cross-check: compared=${s.triggerCrossCheck.compared} oracleOnly=${s.triggerCrossCheck.oracleOnly} triggerOnly=${s.triggerCrossCheck.triggerOnly}\n${s.triggerCrossCheck.samples.map((line) => `  ${line}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
  }

  close(): void {
    this.restoreRandomness();
    this.sqlite.close();
  }
}

function composePage(parts: ReadonlyArray<{ status: number; body: string }>): string {
  return JSON.stringify(parts.map((part) => [part.status, part.body]));
}

function clip(text: string, length = 120): string {
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function firstDifference(stored: string, fresh: string): string {
  let index = 0;
  while (index < stored.length && index < fresh.length && stored[index] === fresh[index]) index += 1;
  const from = Math.max(0, index - 80);
  return `at ${index}\n    cached: ${JSON.stringify(stored.slice(from, index + 120))}\n    fresh:  ${JSON.stringify(fresh.slice(from, index + 120))}`;
}
