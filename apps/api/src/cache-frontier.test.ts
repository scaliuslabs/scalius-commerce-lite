import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import {
  CACHE_COMMIT_SEQ_HEADER,
  CACHE_FRONTIER_KEY_HEADER,
  CACHE_FRONTIER_SECRET_PURPOSE,
  hashCacheDep,
} from "@scalius/shared/cache-frontier";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";
import {
  FRONTIER_CHECK_MAX_ROWS,
  checkHashedDependencies,
  hasFrontierKey,
  readCommitSeq,
  readFrontierDelta,
  readValidationSnapshot,
} from "./cache-frontier";
import { frontierSlice } from "./testing/cache-dvc/clocks";
import { commitSeqMiddleware } from "./middleware/commit-seq";

/** A store whose cache_dep rows are set directly (the clock trigger follows them). */
function store(provider: "d1" | "turso" = "d1") {
  const { sqlite, db } = createSqliteD1Database();
  const database: Database = provider === "turso" ? createSqliteTursoDatabase(sqlite) : db;
  const bump = (seq: number, deps: readonly string[]) => {
    for (const dep of deps) {
      sqlite.prepare("INSERT INTO cache_dep (dep, seq) VALUES (?, ?) ON CONFLICT (dep) DO UPDATE SET seq = excluded.seq").run(dep, seq);
    }
  };
  const rows = () => (sqlite.prepare("SELECT dep, seq FROM cache_dep ORDER BY seq, dep").all() as Array<{ dep: string; seq: number }>)
    .map((row) => [row.dep, Number(row.seq)] as const);
  const clock = () => Number((sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get() as { seq: number }).seq);
  return { sqlite, db: database, bump, rows, clock };
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe.each(["d1", "turso"] as const)("DVC clock reads (%s)", (provider) => {
  it("validation snapshot: the clock, the floor, the Platform row and exactly the asked keys changed after since", async () => {
    const { db, bump, sqlite } = store(provider);
    // The settings trigger advances the clock too (seq 1).
    sqlite.exec(`INSERT INTO settings (id, key, value, type, category, revision) VALUES ('platform', 'document', '{"storefrontUrl":"https://shop.example"}', 'json', 'platform', 4)`);
    bump(2, ["store", "p:a", "p:b"]);
    bump(3, ["p:a", "lm:all"]);

    const snapshot = await readValidationSnapshot(db, ["p:a", "p:b", "p:missing", "store"], 2);

    expect(snapshot.S).toBe(3);
    expect(snapshot.floor).toBe(0);
    expect([...snapshot.changed.entries()]).toEqual([["p:a", 3]]);
    expect(snapshot.platform).toEqual({ value: '{"storefrontUrl":"https://shop.example"}', revision: 4 });
    expect((await readValidationSnapshot(db, [], 0)).changed.size).toBe(0);
  });

  it("binds any number of keys as one JSON value (D1's 100-parameter limit)", async () => {
    const { db, bump } = store(provider);
    const keys = Array.from({ length: 2_000 }, (_, index) => `p:${index}`);
    bump(1, keys);
    bump(2, ["p:1999"]);

    const snapshot = await readValidationSnapshot(db, keys, 1);

    expect([...snapshot.changed.entries()]).toEqual([["p:1999", 2]]);
  });

  it("frontier delta equals the reference slicing, hashed, for random stores, sinces and limits", async () => {
    const random = lcg(provider === "d1" ? 7 : 11);
    for (let round = 0; round < 12; round += 1) {
      const { db, bump, rows, clock } = store(provider);
      let seq = 0;
      for (let write = 0; write < 30; write += 1) {
        seq += 1;
        // Mostly small writes, sometimes a bulk one wider than the limit.
        const width = random() < 0.15 ? 9 : 1 + Math.floor(random() * 3);
        bump(seq, Array.from({ length: width }, () => `p:${Math.floor(random() * 40)}`));
      }
      const all = rows();
      for (const limit of [1, 2, 5, 8, 50]) {
        for (const since of [null, 0, Math.floor(seq / 3), seq - 1, seq]) {
          const mine = await readFrontierDelta(db, since, limit);
          const reference = frontierSlice(all, clock(), since, limit, 0);
          expect({ S: mine.S, horizon: mine.horizon, changes: mine.changes }, `since=${since} limit=${limit}`).toEqual({
            S: reference.S,
            horizon: reference.horizon,
            changes: reference.changes.map(([dep, at]) => [hashCacheDep(dep), at]),
          });
          // A capped answer never claims past what it holds.
          expect(mine.S).toBeLessThanOrEqual(mine.clock);
          expect(mine.changes.length).toBeLessThanOrEqual(limit);
        }
      }
    }
  });

  it("frontier slow path: hashed keys in, changed after s0 out; bounded, and below the floor always changed", async () => {
    const { db, bump, sqlite } = store(provider);
    bump(1, ["p:a", "p:b"]);
    bump(2, ["p:c"]);

    expect(await checkHashedDependencies(db, 1, [hashCacheDep("p:a"), hashCacheDep("p:b")])).toEqual({ S: 2, floor: 0, changed: false });
    expect((await checkHashedDependencies(db, 1, [hashCacheDep("p:c")])).changed).toBe(true);
    expect((await checkHashedDependencies(db, 0, [hashCacheDep("p:a")])).changed).toBe(true);

    sqlite.exec("UPDATE cache_clock SET floor = 2 WHERE id = 1");
    expect((await checkHashedDependencies(db, 1, [hashCacheDep("p:a")])).changed).toBe(true);
    expect(FRONTIER_CHECK_MAX_ROWS).toBeGreaterThan(4_000);
  });

  it("commit seq is the clock after the write", async () => {
    const { db, bump } = store(provider);
    bump(5, ["p:a"]);
    expect(await readCommitSeq(db)).toBe(5);
  });
});

describe("frontier key", () => {
  const secret = "frontier-test-master-secret-0123456789abcdef";

  it("accepts only the HKDF purpose key of the master secret", async () => {
    const key = await deriveRuntimeSecret(secret, CACHE_FRONTIER_SECRET_PURPOSE);
    const request = (value?: string) => new Request("https://api.internal/api/v1/storefront/frontier", value ? { headers: { [CACHE_FRONTIER_KEY_HEADER]: value } } : {});

    expect(await hasFrontierKey(request(key), { SCALIUS_SECRET: secret })).toBe(true);
    expect(await hasFrontierKey(request(`${key.slice(0, -1)}x`), { SCALIUS_SECRET: secret })).toBe(false);
    expect(await hasFrontierKey(request(), { SCALIUS_SECRET: secret })).toBe(false);
    expect(await hasFrontierKey(request(key), {})).toBe(false);
  });
});

describe("commit seq middleware", () => {
  function app(clock: () => Promise<number>) {
    const db = { all: async () => [{ s: await clock() }] } as unknown as Database;
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("db" as never, db as never);
      await next();
    });
    hono.use("*", commitSeqMiddleware);
    hono.post("/ok", (c) => c.json({ ok: true }));
    hono.post("/fail", (c) => c.json({ ok: false }, 409));
    hono.get("/read", (c) => c.json({ ok: true }));
    return hono;
  }

  it("answers a successful write with the clock, and nothing else", async () => {
    const hono = app(async () => 42);
    expect((await hono.request("/ok", { method: "POST" })).headers.get(CACHE_COMMIT_SEQ_HEADER)).toBe("42");
    expect((await hono.request("/fail", { method: "POST" })).headers.has(CACHE_COMMIT_SEQ_HEADER)).toBe(false);
    expect((await hono.request("/read")).headers.has(CACHE_COMMIT_SEQ_HEADER)).toBe(false);
  });

  it("never fails the write when the clock cannot be read", async () => {
    const hono = app(async () => {
      throw new Error("down");
    });
    const response = await hono.request("/ok", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.has(CACHE_COMMIT_SEQ_HEADER)).toBe(false);
  });
});
