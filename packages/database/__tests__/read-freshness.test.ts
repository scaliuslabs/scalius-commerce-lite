import { drizzle } from "drizzle-orm/d1";
import { afterAll, describe, expect, it } from "vitest";

import {
  assertReadsAreUncached,
  CachedReadError,
  READ_FRESHNESS_PROBE_KEY,
} from "../src/read-freshness";
import * as schema from "../src/schema";
import {
  createMigratedSqlite,
  createSqliteD1Binding,
  withSimulatedQueryCache,
} from "../src/testing/sqlite-d1";
import {
  closeNativePostgres,
  createNativePostgres,
  NATIVE_POSTGRES_TEST_TIMEOUT,
  nativePostgresUrl,
} from "../src/testing/postgres-native";
import type { Database } from "../src/types";

function database(binding: D1Database): Database {
  return drizzle(binding, { schema }) as unknown as Database;
}

describe("read freshness probe", () => {
  it("passes when every read sees the write before it, again and again", async () => {
    const sqlite = createMigratedSqlite();
    const db = database(createSqliteD1Binding(sqlite));

    await assertReadsAreUncached(db);
    await assertReadsAreUncached(db);

    const rows = sqlite
      .prepare("SELECT COUNT(*) AS n FROM rate_limit WHERE key = ?")
      .get(READ_FRESHNESS_PROBE_KEY) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("fails closed when reads come from a query cache", async () => {
    const sqlite = createMigratedSqlite();
    const db = database(withSimulatedQueryCache(createSqliteD1Binding(sqlite)));

    await expect(assertReadsAreUncached(db)).rejects.toBeInstanceOf(CachedReadError);
    // A cache warmed by an earlier probe is caught too.
    await expect(assertReadsAreUncached(db)).rejects.toThrow(/--caching-disabled/);
  });

  it("writes no cache dependency and no domain event", async () => {
    const sqlite = createMigratedSqlite();
    const db = database(createSqliteD1Binding(sqlite));
    const count = (table: string) =>
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = { deps: count("cache_dep"), events: count("event_outbox") };

    await assertReadsAreUncached(db);

    expect({ deps: count("cache_dep"), events: count("event_outbox") }).toEqual(before);
  });
});

// Opt-in: SCALIUS_TEST_POSTGRES_URL points at a disposable server. The probe's
// SQL then runs through the production pg adapter and its SQLite profile.
describe.runIf(nativePostgresUrl())("read freshness probe on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  afterAll(closeNativePostgres);

  it("passes against an uncached server and upserts one private row", async () => {
    const { db, client } = await createNativePostgres({ label: "readfresh", seed: false });

    await assertReadsAreUncached(db);
    await assertReadsAreUncached(db);

    const rows = await client.query("SELECT COUNT(*)::int AS n FROM rate_limit WHERE key = $1", [READ_FRESHNESS_PROBE_KEY]);
    expect(rows.rows[0]?.n).toBe(1);
  });
});
