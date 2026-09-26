// PostgreSQL parity of S4's change-clock reads (cache-frontier.ts): the same
// sequence of dependency bumps on D1 (SQLite) and on a real PostgreSQL server
// gives the same validation snapshots, frontier deltas, slow-path answers and
// commit seqs, through the adapter's SQLite-profile compiler. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable local server; the test creates
// and drops its own database.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import type { Database } from "@scalius/database/client";
import { hashCacheDep } from "@scalius/shared/cache-frontier";
import {
  checkHashedDependencies,
  readCommitSeq,
  readFrontierDelta,
  readValidationSnapshot,
} from "./cache-frontier";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

/** The canonical PostgreSQL schema, compiled by the database package's own script. */
function canonicalPostgresSchemaSql(): string {
  const databaseDir = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
  const out = join(mkdtempSync(join(tmpdir(), "scalius-s4-pg-schema-")), "schema.sql");
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  execFileSync(tsx, ["scripts/postgres-schema.ts", "--out", out], { cwd: databaseDir });
  return readFileSync(out, "utf8");
}
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const parseBigint = ((oid: number, format?: "text" | "binary") =>
  oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser;

async function postgres(): Promise<{ db: Database; client: Client }> {
  const name = `scalius_s4_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString(), types: { getTypeParser: parseBigint } });
  await client.connect();
  await client.query(canonicalPostgresSchemaSql());
  cleanups.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { db: createPostgresDatabase(url.toString(), { connect: connectPostgres }), client };
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe.runIf(postgresUrl)("S4 clock reads: PostgreSQL parity with D1", () => {
  it("answers exactly as D1 for the same bumps", async () => {
    const pg = await postgres();
    const { sqlite, db: d1 } = createSqliteD1Database();
    const random = lcg(20260925);
    const writes: string[][] = [];
    for (let write = 0; write < 40; write += 1) {
      const width = random() < 0.15 ? 9 : 1 + Math.floor(random() * 3);
      writes.push([...new Set(Array.from({ length: width }, () => `p:${Math.floor(random() * 40)}`))]);
    }
    const d1Start = Number((sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get() as { seq: number }).seq);
    // A fresh PostgreSQL schema has no clock row until its first bump: clock 0.
    const pgStart = Number((await pg.client.query("SELECT COALESCE((SELECT seq FROM cache_clock WHERE id = 1), 0) AS seq")).rows[0].seq);
    expect(await readCommitSeq(pg.db)).toBe(pgStart);
    expect((await readValidationSnapshot(pg.db, ["store"], 0)).S).toBe(pgStart);
    expect(pgStart).toBe(d1Start);
    for (const [index, keys] of writes.entries()) {
      // One committed write: one clock tick for all its keys, as the triggers do.
      for (const key of keys) {
        sqlite.prepare("INSERT INTO cache_dep (dep, seq) VALUES (?, ?) ON CONFLICT (dep) DO UPDATE SET seq = excluded.seq").run(key, d1Start + index + 1);
      }
      await pg.client.query("SELECT scalius_compat.cache_dep_bump($1::text[])", [keys]);
    }
    const clock = d1Start + writes.length;
    expect(await readCommitSeq(pg.db)).toBe(clock);
    expect(await readCommitSeq(d1)).toBe(clock);

    const all = Array.from({ length: 40 }, (_, index) => `p:${index}`);
    for (const since of [d1Start, d1Start + 10, clock - 3, clock]) {
      const [a, b] = await Promise.all([readValidationSnapshot(d1, all, since), readValidationSnapshot(pg.db, all, since)]);
      expect({ ...b, changed: [...b.changed.entries()].sort() }, `snapshot since ${since}`)
        .toEqual({ ...a, changed: [...a.changed.entries()].sort() });
      for (const limit of [1, 3, 8, 100]) {
        expect(await readFrontierDelta(pg.db, since, limit), `delta since ${since} limit ${limit}`)
          .toEqual(await readFrontierDelta(d1, since, limit));
      }
      const hashes = all.slice(0, 7).map(hashCacheDep);
      expect(await checkHashedDependencies(pg.db, since, hashes)).toEqual(await checkHashedDependencies(d1, since, hashes));
    }
    for (const limit of [1, 3, 8, 100]) {
      expect(await readFrontierDelta(pg.db, null, limit)).toEqual(await readFrontierDelta(d1, null, limit));
    }
  }, 180_000);

  it("reads the Platform row and real trigger bumps in the validation statement", async () => {
    const pg = await postgres();
    await pg.client.query(`INSERT INTO settings (id, key, value, type, category, revision) VALUES ('platform', 'document', '{"storefrontUrl":"https://shop.example"}', 'json', 'platform', 3)`);
    const before = await readValidationSnapshot(pg.db, ["set:platform:document", "store"], 0);
    expect(before.platform).toEqual({ value: '{"storefrontUrl":"https://shop.example"}', revision: 3 });
    expect(before.changed.get("set:platform:document")).toBe(before.S);

    await pg.client.query(`UPDATE settings SET value = '{"storefrontUrl":"https://shop2.example"}' WHERE id = 'platform'`);
    const after = await readValidationSnapshot(pg.db, ["set:platform:document", "store"], before.S);
    expect(after.S).toBeGreaterThan(before.S);
    expect([...after.changed.keys()]).toEqual(["set:platform:document"]);
    expect(after.platform?.value).toContain("shop2");
  }, 180_000);
});
