/**
 * DVC counter ordering and races (CACHE-DESIGN §7 item 4, §6.8 L1/L2).
 *
 * A render reads the clock (`s0`) first, then data. A write that commits
 * after that read has `seq > s0`, so whatever the render stored must be
 * rejected on the next hit if the write changed what it shows; a write that
 * committed before the read is visible to the render and the entry is fresh.
 *
 * - Every commit point: for several routes and a write that changes each
 *   one, the write is committed before each statement of the render in turn,
 *   and after the render but before the cache put. The stored entry must
 *   never validate while differing from a fresh render, and a write after
 *   the clock read must always invalidate it.
 * - Concurrent fills: many renders in flight at once with committed writes
 *   interleaved between their statements; afterwards no valid entry may
 *   differ from a fresh render.
 * - Slow page: a storefront page composed across a commit is never served
 *   stale once the frontier is older than Δ.
 */
import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { DvcHarness } from "./testing/cache-dvc/harness";
import { s4Adapters, scopeRecorder, type S4AdapterOptions } from "./testing/cache-dvc/harness-adapters";
import { dvcPageCatalogue, dvcPartCatalogue } from "./testing/cache-dvc/routes";

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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

/**
 * S4's production part cache (its reader's recording, validator and
 * frontier); `lateClockRead` is the harness's own negative control and runs
 * on S2's recorder, whose s0 the harness reads itself.
 */
async function harness(seed: string, raceRate = 0, lateClockRead = false, s4Options: S4AdapterOptions = {}): Promise<DvcHarness> {
  const stats = { coarse: new Map<string, number>(), unobserved: new Map<string, number>() };
  if (lateClockRead) {
    return DvcHarness.create({
      seed,
      raceRate,
      lateClockRead,
      setSystemTime: (ms) => vi.setSystemTime(ms),
      recorder: ({ model }) => scopeRecorder(stats, new Set(model.keys())),
    });
  }
  const s4 = s4Adapters(s4Options);
  return DvcHarness.create({
    seed,
    raceRate,
    setSystemTime: (ms) => vi.setSystemTime(ms),
    recorder: s4.recorder(stats),
    partValidator: (clock) => s4.partValidator(clock),
    frontierModel: s4.frontierModel,
  });
}

/** Routes and a committed write that visibly changes each. */
const CASES: ReadonlyArray<{ path: string; write: (sqlite: DatabaseSync) => void }> = [
  { path: "/api/v1/products/linen-panjabi", write: (sqlite) => sqlite.exec("UPDATE products SET name = name || ' II' WHERE id = 'p_linen'") },
  { path: "/api/v1/products/silk-panjabi", write: (sqlite) => sqlite.exec("UPDATE product_variants SET price_minor = price_minor + 100 WHERE id = 'v_silk_m_gold'") },
  { path: "/api/v1/products/cotton-panjabi", write: (sqlite) => sqlite.exec("UPDATE product_variants SET stock = 0, stock_version = stock_version + 1 WHERE id = 'v_cotton'") },
  { path: "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest", write: (sqlite) => sqlite.exec("UPDATE product_buyer_state SET from_minor = from_minor + 500, to_minor = to_minor + 500, base_minor = base_minor + 500 WHERE product_id = 'p_cotton'") },
  { path: "/api/v1/categories/men/products?page=1&limit=20&sort=newest", write: (sqlite) => sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p_linen'") },
  { path: "/api/v1/storefront/layout", write: (sqlite) => sqlite.exec("UPDATE settings SET value = json_set(value, '$.homepageTitle', 'Renamed') WHERE category = 'seo'") },
  { path: "/api/v1/checkout/config", write: (sqlite) => sqlite.exec("UPDATE shipping_methods SET fee_minor = fee_minor + 1000 WHERE id = 'ship_dhaka'") },
  { path: "/api/v1/collections/col_dynamic", write: (sqlite) => sqlite.exec("UPDATE categories SET parent_id = 'cat_women' WHERE id = 'cat_festive'") },
];

describe("DVC render/commit races", () => {
  it("rejects every entry whose render a later commit overtook, at every commit point", async () => {
    let checked = 0;
    for (const { path, write } of CASES) {
      // Count the render's statements once.
      const probe = await harness(`race-probe-${path}`);
      const { statements } = await probe.renderWithCommit(path, Number.MAX_SAFE_INTEGER, () => undefined);
      probe.close();
      expect(statements, path).toBeGreaterThan(0);
      for (let at = 0; at <= statements; at += 1) {
        const run = await harness(`race-${path}-${at}`);
        try {
          const before = await run.clock.current();
          await run.renderWithCommit(path, at, write);
          const after = await run.clock.current();
          expect(after, `${path}: the write advanced the clock`).toBeGreaterThan(before);
          const verdict = await run.checkPart(path);
          if (!verdict.cached) continue;
          // G2: a valid entry is byte-identical to a fresh render.
          expect(verdict.valid && !verdict.equal, `${path} commit before statement ${at}: stale entry validated`).toBe(false);
          // The write committed after the clock read, and it changes the page: never valid.
          if (!verdict.equal) expect(verdict.valid, `${path} commit before statement ${at}`).toBe(false);
          checked += 1;
        } finally {
          run.close();
        }
      }
    }
    expect(checked).toBeGreaterThan(CASES.length * 3);
  }, 600_000);

  it("has teeth: a render that reads the clock after its data is caught serving stale", async () => {
    const { path, write } = CASES[0]!;
    let caught = 0;
    for (const at of [0, 3, 6]) {
      const run = await harness(`race-late-${at}`, 0, true);
      try {
        await run.renderWithCommit(path, at, write);
        const verdict = await run.checkPart(path);
        if (verdict.valid && !verdict.equal) caught += 1;
      } finally {
        run.close();
      }
    }
    expect(caught, "the ordering bug went unnoticed").toBeGreaterThan(0);
  }, 120_000);

  it("has teeth: S4's reader taking its s0 from a clock read after the render is caught serving stale", async () => {
    const { path, write } = CASES[0]!;
    let caught = 0;
    for (const at of [0, 3, 6]) {
      const run = await harness(`race-s4-late-${at}`, 0, false, { clockAfterRender: true });
      try {
        await run.renderWithCommit(path, at, write);
        const verdict = await run.checkPart(path);
        if (verdict.valid && !verdict.equal) caught += 1;
      } finally {
        run.close();
      }
    }
    expect(caught, "the ordering bug went unnoticed").toBeGreaterThan(0);
  }, 120_000);

  it("keeps the guarantee when renders take s0 from a clock snapshot older than every write since", async () => {
    // The snapshot is read once and never refreshed: every entry's s0 lags the
    // clock by all writes before it, the extreme of the data center snapshot.
    let checked = 0;
    for (const { path, write } of CASES) {
      const run = await harness(`race-s4-old-${path}`, 0, false, { snapshotRefreshRate: 0 });
      try {
        await run.renderWithCommit("/api/v1/storefront/layout", Number.MAX_SAFE_INTEGER, () => undefined);
        for (let round = 0; round < 3; round += 1) {
          await run.renderWithCommit(path, round, write);
          const verdict = await run.checkPart(path);
          if (!verdict.cached) continue;
          expect(verdict.valid && !verdict.equal, `${path} round ${round}: stale entry validated`).toBe(false);
          checked += 1;
        }
      } finally {
        run.close();
      }
    }
    expect(checked).toBeGreaterThan(CASES.length);
  }, 600_000);

  it("keeps the guarantee with concurrent fills and writes interleaved between their statements", async () => {
    const parts = dvcPartCatalogue();
    for (let round = 0; round < 6; round += 1) {
      const run = await harness(`race-concurrent-${round}`, 0.08);
      try {
        await run.readPartsConcurrently(parts);
        expect(run.stats.raceInjections, "writes were interleaved").toBeGreaterThan(0);
        for (const path of parts) {
          const verdict = await run.checkPart(path);
          if (verdict.cached) expect(verdict.valid && !verdict.equal, `${path}: stale entry validated (round ${round})`).toBe(false);
        }
      } finally {
        run.close();
      }
    }
  }, 600_000);

  it("never serves a page composed across a commit once the frontier catches up", async () => {
    const run = await harness("race-page", 0.1);
    try {
      const pages = dvcPageCatalogue();
      for (let round = 0; round < 40; round += 1) {
        for (const page of pages) await run.readPage(page);
        run.tick(1_100);
      }
      expect(run.stats.raceInjections).toBeGreaterThan(0);
      expect(run.stats.pageServed).toBeGreaterThan(0);
    } finally {
      run.close();
    }
  }, 600_000);
});
