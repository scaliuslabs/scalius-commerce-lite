/**
 * The DVC release gate (CACHE-DESIGN §7 items 1 and 3): a missed invalidation
 * cannot ship.
 *
 * The real API renders every cached public read in-process over a seeded
 * store; a random walk of row mutations of any table, curated service writes,
 * stock-band walks, category moves, JSON document edits and clock jumps
 * across promotion boundaries runs against it. After every step each cached
 * API part the validator calls valid must equal a fresh render byte for byte,
 * and each storefront page hit must satisfy G1 (frontier no older than Δ, no
 * dependency changed in (s0, F.S], body equal to the page at F.S).
 *
 * Modes (environment):
 *   (default)          quick: the coverage sweep plus DVC_STEPS (default 150) random steps; CI.
 *   DVC_MODE=long      DVC_STEPS (default 20000) steps per seed, DVC_SEEDS seeds; see scripts/cache-dvc-long.mjs.
 *   DVC_SEED=<seed>    replay one seed (with the DVC_STEPS the failure printed).
 *   DVC_PROVIDER=turso the real Turso adapter over the same SQLite store.
 *   DVC_CLOCK=reference|triggers|auto (default auto: S1's triggers once the migration exists).
 *   DVC_RACE=<p>       inject a committed write before a render statement with probability p.
 *   DVC_FRONTIER_CAP / DVC_FRONTIER_LIMIT  small values exercise frontier trimming and capped deltas.
 *   DVC_REPORT=<file>  write the run's stats as JSON.
 */
import "@hono/zod-openapi";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { CACHE_DEP_TABLES } from "@scalius/shared/cache-deps";
import { DvcHarness, type DvcHarnessConfig } from "./testing/cache-dvc/harness";
import {
  s4Adapters,
  scopeRecorder,
  type S4AdapterOptions,
  type S4Adapters,
  type ScopeRecorderStats,
} from "./testing/cache-dvc/harness-adapters";
import { referencePartValidator } from "./testing/cache-dvc/validators";
import { Rng } from "./testing/cache-dvc/rng";
import { STRUCTURAL_OP_GAPS } from "./testing/cache-dvc/mutations";
import { registryColumnsMissingFromSchema, registryTablesMissingFromSchema } from "./testing/cache-dvc/schema-model";

vi.mock("@scalius/database/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/database/client")>();
  return {
    ...actual,
    getDb: (env?: Record<string, unknown>) => (env && env.__DVC_DB ? env.__DVC_DB : actual.getDb(env as never)) as ReturnType<typeof actual.getDb>,
  };
});

// nanoid keeps a module-level byte pool, so an id minted inside a render
// depends on every id minted before it. Draw each id straight from
// crypto.getRandomValues, which the harness seeds per render; a render that
// mints an id (footer social links without one) is then a pure function.
vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return {
    ...actual,
    nanoid: (size = 21) => {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
      let id = "";
      for (const byte of bytes) id += actual.urlAlphabet[byte & 63];
      return id;
    },
  };
});

const MODE = process.env.DVC_MODE === "long" ? "long" : "quick";
const STEPS = Number(process.env.DVC_STEPS ?? (MODE === "long" ? 20_000 : 150));
const PROVIDER = process.env.DVC_PROVIDER === "turso" ? "turso" : "d1";
const CLOCK = (process.env.DVC_CLOCK ?? "auto") as DvcHarnessConfig["clock"];
const RACE = Number(process.env.DVC_RACE ?? (MODE === "long" ? 0.02 : 0.01));
const SEEDS = process.env.DVC_SEED
  ? [process.env.DVC_SEED]
  : Array.from({ length: Number(process.env.DVC_SEEDS ?? 1) }, (_, index) => `${process.env.DVC_SEED_PREFIX ?? "dvc"}-${index + Number(process.env.DVC_SEED_OFFSET ?? 0)}`);
const TIMEOUT = MODE === "long" ? 24 * 3600_000 : 240_000;

/**
 * `s4` (default): S4's production part cache end to end (the part reader's
 * recording with a deliberately stale clock snapshot, its one-statement
 * validator, its frontier delta and the shared frontier rule). `scope`: S2's
 * recorder with the reference validator and frontier. `coarse`: table keys only.
 */
const RECORDER = process.env.DVC_RECORDER === "coarse" ? "coarse" : process.env.DVC_RECORDER === "scope" ? "scope" : "s4";
const scopeStats: ScopeRecorderStats = { coarse: new Map(), unobserved: new Map() };
const s4Runs: Array<S4Adapters["stats"]> = [];

function harnessConfig(seed: string, s4Options: S4AdapterOptions = {}): DvcHarnessConfig {
  const s4 = RECORDER === "s4"
    ? s4Adapters({
      snapshotRefreshRate: Number(process.env.DVC_SNAPSHOT_REFRESH ?? 0.5),
      random: (() => {
        const rng = new Rng(`s4-snapshot:${seed}`);
        return () => rng.next();
      })(),
      ...(PROVIDER === "turso" ? { database: (sqlite: DatabaseSync) => createSqliteTursoDatabase(sqlite) } : {}),
      ...s4Options,
    })
    : null;
  if (s4) s4Runs.push(s4.stats);
  return {
    ...(RECORDER === "scope" ? { recorder: ({ model }) => scopeRecorder(scopeStats, new Set(model.keys())) } : {}),
    ...(s4 ? { recorder: s4.recorder(scopeStats), partValidator: (clock) => s4.partValidator(clock), frontierModel: s4.frontierModel } : {}),
    seed,
    provider: PROVIDER,
    clock: CLOCK,
    raceRate: RACE,
    frontierCap: Number(process.env.DVC_FRONTIER_CAP ?? 24),
    frontierDeltaLimit: Number(process.env.DVC_FRONTIER_LIMIT ?? 16),
    fullCheckEvery: Number(process.env.DVC_FULL_CHECK_EVERY ?? (MODE === "long" ? 5 : 1)),
    setSystemTime: (ms) => vi.setSystemTime(ms),
    collect: process.env.DVC_COLLECT === "1",
    log: (line) => console.error(line),
    ...(PROVIDER === "turso" ? { providerDatabase: (sqlite: DatabaseSync) => createSqliteTursoDatabase(sqlite) } : {}),
  };
}

const reports: unknown[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  if (process.env.DVC_REPORT) writeFileSync(process.env.DVC_REPORT, JSON.stringify(reports, null, 2));
});

describe("DVC registry", () => {
  it("names only tables and columns the schema has", async () => {
    const harness = await DvcHarness.create(harnessConfig("registry"));
    try {
      expect(registryTablesMissingFromSchema(harness.model)).toEqual([]);
      expect(registryColumnsMissingFromSchema(harness.model)).toEqual([]);
      expect(Object.keys(CACHE_DEP_TABLES).length).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  }, 60_000);
});

const PRODUCT_KEYS = /^(?:p:|t:products$|t:product_variants$|t:product_buyer_state$)/;

describe("DVC property harness has teeth", () => {
  it("catches a validator that ignores the product keys", async () => {
    const harness = await DvcHarness.create({
      ...(RECORDER === "s4"
        ? harnessConfig("teeth", { blindTo: PRODUCT_KEYS })
        : {
          ...harnessConfig("teeth"),
          partValidator: (clock) => {
            const inner = referencePartValidator(clock);
            return {
              name: "blind-to-products",
              validate: (entries, now) => inner.validate(entries.map((entry) => ({
                ...entry,
                deps: entry.deps.filter((dep) => !PRODUCT_KEYS.test(dep)),
              })), now),
            };
          },
        } satisfies DvcHarnessConfig),
      collect: true,
      raceRate: 0,
    });
    try {
      await harness.warm();
      for (let step = 0; step < 60 && harness.findings.size === 0; step += 1) await harness.runStep();
      expect(harness.findings.size, "a blind validator went unnoticed").toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  }, 120_000);
});

describe(`DVC differential property (${MODE}, ${PROVIDER})`, () => {
  for (const seed of SEEDS) {
    it(`never serves a stale entry as valid: ${seed}`, async () => {
      const harness = await DvcHarness.create(harnessConfig(seed));
      const s4Stats = RECORDER === "s4" ? s4Runs[s4Runs.length - 1]! : null;
      const started = performance.now();
      let nonOk: string[] = [];
      let failure: unknown = null;
      let completed = 0;
      try {
        await harness.warm();
        nonOk = harness.nonOkParts();
        expect.soft(harness.stats.nondeterministicRoutes, "routes whose output is not a function of the database and time").toEqual([]);
        if (MODE === "quick" && !process.env.DVC_SEED) await harness.sweep();
        for (let step = 0; step < STEPS; step += 1) {
          await harness.runStep();
          completed = step + 1;
          if (MODE === "long" && completed % 1000 === 0) {
            console.error(`[DVC progress] ${seed} ${completed}/${STEPS} steps, ${harness.stats.writes} writes, ${harness.stats.partChecks} part checks, ${harness.findings.size} findings, rss ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        const gaps = harness.coverage.gaps(harness.model);
        reports.push({
          seed, mode: MODE, provider: PROVIDER, steps: completed, wallSeconds: (performance.now() - started) / 1000,
          stats: harness.stats, coverage: gaps, nonOk, refusals: Object.fromEntries(harness.coverage.refusals),
          findings: [...harness.findings.values()].map(({ signature, count, firstReport }) => ({ signature, count, firstReport })),
          error: failure ? String(failure instanceof Error ? failure.message : failure) : null,
        });
        if (process.env.DVC_REPORT) writeFileSync(process.env.DVC_REPORT, JSON.stringify(reports, null, 2));
        console.info(`[DVC] findings:\n${[...harness.findings.values()].map((finding) => `- (${finding.count}x) ${finding.signature}`).join("\n") || "none"}`);
        console.info(`[DVC] coverage gaps:\n  ops: ${gaps.ops.join(" ")}\n  noise columns: ${gaps.noise.join(" ") || "none"}\n  columns: ${gaps.columns.join(" ")}\n[DVC] refusals:\n${[...harness.coverage.refusals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, count]) => `  ${count}x ${key}`).join("\n")}`);
        console.info(`[DVC] ${harness.summary()}\nnon-200 parts: ${nonOk.join(" ") || "none"}\nwall ${((performance.now() - started) / 1000).toFixed(1)}s`);
        if (RECORDER === "s4") console.info(`[DVC] s4 snapshot: ${JSON.stringify(s4Runs[s4Runs.length - 1])}`);
        if (RECORDER !== "coarse") {
          const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([key, count]) => `  ${count}x ${key}`).join("\n") || "  none";
          console.info(`[DVC] coarse fallbacks (route table):\n${top(scopeStats.coarse)}\n[DVC] tables the harness saw but S2 did not report:\n${top(scopeStats.unobserved)}`);
        }
        harness.close();
      }
      if (failure) throw failure;
      if (MODE === "quick" && !process.env.DVC_SEED) {
        const gaps = harness.coverage.gaps(harness.model);
        expect(gaps.noise, "noise columns the run never changed").toEqual([]);
        expect(gaps.ops.filter((op) => !(op in STRUCTURAL_OP_GAPS)), "registered table operations the run never performed").toEqual([]);
        // The reader's s0 came from a snapshot older than the clock (a lower bound) on real renders.
        if (s4Stats) expect(s4Stats.staleSnapshotRenders, "renders from a stale clock snapshot").toBeGreaterThan(0);
      }
      harness.assertNoFindings();
    }, TIMEOUT);
  }
});
