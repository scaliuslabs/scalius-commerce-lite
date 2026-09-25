// Migration 0093 (dependency-validated cache, phase P0): the checked-in SQL
// equals the generator output, every registered rule has its trigger on every
// provider, every table is registered or exempt, and the triggers advance
// exactly the registry's keys on D1, node:sqlite Turso and the real Turso
// engine, with a clock that orders commits.
import { readFileSync } from "node:fs";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";

import {
  CACHE_DEP_EXEMPT_TABLES,
  CACHE_DEP_TABLES,
  cacheDepKind,
  isCacheDep,
  type CacheDepTableSpec,
} from "../../shared/src/cache-deps";
import {
  CACHE_DEP_CLOCK_TRIGGERS,
  CACHE_DEP_MIGRATION,
  CACHE_DEP_MIGRATION_PATHS,
  CACHE_DEP_TRIGGER_PREFIX,
  generateCacheDepTriggers,
  renderCacheDepMigration,
} from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";
import { bumped, runCacheDepScenario, type CacheDepDriver } from "./cache-dep-scenario";

const BREAKPOINT = "--> statement-breakpoint";

function nodeDriver(provider: "d1" | "turso", foreignKeys = true): CacheDepDriver & { sqlite: ReturnType<typeof createMigratedSqlite> } {
  const sqlite = createMigratedSqlite({ provider, foreignKeys });
  return {
    sqlite,
    exec: async (sql) => { sqlite.exec(sql); },
    rows: async (sql) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>,
  };
}

const expectedTriggerNames = () => Object.entries(CACHE_DEP_TABLES as Record<string, CacheDepTableSpec>)
  .flatMap(([table, spec]) => spec.rules.map((rule) => `${CACHE_DEP_TRIGGER_PREFIX}${table}_${rule.name}`))
  .sort();

describe("0093_cache_dependencies", () => {
  it("is exactly the generator output from the registry, for D1/Turso and PostgreSQL", () => {
    const rendered = renderCacheDepMigration();
    expect(readFileSync(CACHE_DEP_MIGRATION_PATHS.sqlite, "utf8")).toBe(rendered.sqlite);
    expect(readFileSync(CACHE_DEP_MIGRATION_PATHS.postgres, "utf8")).toBe(rendered.postgres);
    expect(rendered.sqlite).toContain(`VALUES (${CACHE_DEP_MIGRATION.version}, '${CACHE_DEP_MIGRATION.name}'`);
  });

  it("keeps the remote D1 trigger rules: no CASE, the guard in WHEN, one statement per body", () => {
    const triggers = generateCacheDepTriggers();
    for (const trigger of triggers) {
      expect(trigger.sqlite, trigger.name).not.toMatch(/\bCASE\b/i);
      const body = trigger.sqlite.slice(trigger.sqlite.indexOf("\nBEGIN\n") + 7, trigger.sqlite.lastIndexOf("\nEND"));
      expect(body.trim().split(";").filter((part) => part.trim()).length, trigger.name).toBe(1);
      expect(body.trim(), trigger.name).toMatch(/^INSERT INTO `cache_dep`/);
    }
    // No trigger body in the migration, generated or not, embeds SELECT CASE WHEN.
    expect(readFileSync(CACHE_DEP_MIGRATION_PATHS.sqlite, "utf8")).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
  });

  it.each(["d1", "turso"] as const)("installs every registry rule as a %s trigger, and nothing else", (provider) => {
    const sqlite = createMigratedSqlite({ provider });
    const rows = sqlite.prepare(
      "SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'cdep\\_%' ESCAPE '\\' OR name LIKE 'cache\\_dep\\_%' ESCAPE '\\') ORDER BY name",
    ).all() as Array<{ name: string; tableName: string }>;
    const names = rows.map((row) => row.name);
    expect(names.filter((name) => name.startsWith(CACHE_DEP_TRIGGER_PREFIX))).toEqual(expectedTriggerNames());
    expect(names.filter((name) => !name.startsWith(CACHE_DEP_TRIGGER_PREFIX))).toEqual([...CACHE_DEP_CLOCK_TRIGGERS]);
    // Each registered table has insert, update and delete coverage.
    const events = new Map<string, Set<string>>();
    for (const trigger of generateCacheDepTriggers()) {
      if (!events.has(trigger.table)) events.set(trigger.table, new Set());
      events.get(trigger.table)!.add(trigger.event);
    }
    for (const table of Object.keys(CACHE_DEP_TABLES)) {
      expect([...(events.get(table) ?? [])].sort(), table).toEqual(["delete", "insert", "update"]);
      expect(rows.some((row) => row.tableName === table), table).toBe(true);
    }
    expect(sqlite.prepare("SELECT id, seq, floor, coarse FROM cache_clock").all()).toEqual([{ id: 1, seq: 0, floor: 0, coarse: 0 }]);
  });

  it("has a PostgreSQL trigger for every rule in the sidecar", () => {
    const sidecar = readFileSync(CACHE_DEP_MIGRATION_PATHS.postgres, "utf8");
    const names = [...sidecar.matchAll(/CREATE CONSTRAINT TRIGGER "([a-z0-9_]+)"/g)].map((match) => match[1]).sort();
    expect(names).toEqual(expectedTriggerNames());
    expect(sidecar).toContain('CREATE OR REPLACE FUNCTION scalius_compat."cache_dep_bump"');
  });

  it("classifies every table: registered with triggers, or exempt with a reason", () => {
    const sqlite = createMigratedSqlite();
    const tables = (sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT GLOB '*_fts_*' AND name NOT IN ('_cf_KV', 'd1_migrations')
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    const unclassified = tables.filter((table) =>
      !(table in CACHE_DEP_TABLES) && !(table in CACHE_DEP_EXEMPT_TABLES) && !table.endsWith("_fts"));
    expect(unclassified).toEqual([]);
    const both = Object.keys(CACHE_DEP_TABLES).filter((table) => table in CACHE_DEP_EXEMPT_TABLES);
    expect(both).toEqual([]);
    for (const [table, reason] of Object.entries(CACHE_DEP_EXEMPT_TABLES)) expect(reason.length, table).toBeGreaterThan(20);
    // Registered kinds are real kinds, and every key a rule can emit parses.
    for (const [table, spec] of Object.entries(CACHE_DEP_TABLES as Record<string, CacheDepTableSpec>)) {
      for (const kind of spec.kinds) expect(cacheDepKind(`${kind}:x`) ?? cacheDepKind(kind), table).toBe(kind);
      for (const rule of spec.rules) {
        for (const key of rule.keys) {
          if ("dep" in key) expect(isCacheDep(key.dep), `${table}.${rule.name}`).toBe(true);
          const kind = "dep" in key ? cacheDepKind(key.dep)
            : "prefix" in key ? cacheDepKind(key.prefix.slice(0, -1).split(":")[0]!)
              : cacheDepKind(key.scopes.split(":")[0]!);
          expect(spec.kinds, `${table}.${rule.name}`).toContain(kind);
        }
      }
    }
  });

  it.each(["d1", "turso"] as const)("advances exactly the registry's keys on %s (node:sqlite)", async (provider) => {
    await runCacheDepScenario(nodeDriver(provider));
  });

  it("orders keys by commit: every transaction's keys are newer than every earlier commit", async () => {
    const driver = nodeDriver("d1");
    await driver.exec("INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published')");
    const seen: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      driver.sqlite.exec("BEGIN IMMEDIATE");
      driver.sqlite.exec(`UPDATE categories SET name = 'A${index}' WHERE id = 'cat_a'`);
      driver.sqlite.exec(`INSERT INTO pages (id, title, slug, content) VALUES ('pg_${index}', 'P', 'p-${index}', 'x')`);
      driver.sqlite.exec("COMMIT");
      const [row] = await driver.rows("SELECT seq FROM cache_clock");
      const keys = await driver.rows(`SELECT min(seq) AS low, max(seq) AS high FROM cache_dep WHERE dep IN ('c:cat_a', 'pg:pg_${index}')`);
      expect(Number(keys[0]!.high)).toBe(Number(row!.seq));
      expect(Number(keys[0]!.low)).toBeGreaterThan(seen.at(-1) ?? 0);
      seen.push(Number(row!.seq));
    }
    // A rolled-back transaction leaves no key and no clock movement.
    const before = await driver.rows("SELECT seq FROM cache_clock");
    driver.sqlite.exec("BEGIN IMMEDIATE");
    driver.sqlite.exec("UPDATE categories SET name = 'rolled back' WHERE id = 'cat_a'");
    driver.sqlite.exec("ROLLBACK");
    expect(await driver.rows("SELECT seq FROM cache_clock")).toEqual(before);
  });

  it("advances a promotion only when redemptions can exhaust it", async () => {
    const driver = nodeDriver("d1", false);
    // The checkout guards on redemptions (allocations, order shape) are not under test here.
    for (const { name } of driver.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'promotion_redemptions' AND name NOT LIKE 'cdep\\_%' ESCAPE '\\'",
    ).all() as Array<{ name: string }>) driver.sqlite.exec(`DROP TRIGGER "${name}"`);
    await driver.exec(`
      INSERT INTO promotions (id, name, method, status) VALUES ('promo_open', 'Open', 'automatic', 'active');
      INSERT INTO promotions (id, name, method, status, max_redemptions) VALUES ('promo_cap', 'Capped', 'automatic', 'active', 100);
    `);
    const redemption = (id: string, promotion: string) => `INSERT INTO promotion_redemptions
      (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code, currency_code, discount_amount_minor)
      VALUES ('${id}', '${promotion}', 'order_${id}', 'cust_1', 1, 'SAVE10', 'BDT', 500)`;
    expect(await bumped(driver, redemption("r1", "promo_open"))).toEqual([]);
    expect(await bumped(driver, redemption("r2", "promo_cap"))).toEqual(["promo:promo_cap", "t:promotion_redemptions"]);
  });

  it("runs unchanged on the real Turso engine (0.7), including coarse mode and same-band stock", async () => {
    const database = await connect(":memory:");
    const migrations = compiledMigrationSql("turso").split(BREAKPOINT);
    const own = new Set(compiledMigrationSql("turso", undefined, "0093_").split(BREAKPOINT).map((statement) => statement.trim()));
    const failures: string[] = [];
    for (const statement of migrations) {
      try {
        await database.exec(statement);
      } catch (error) {
        // Two pre-0093 backfills use SQL the local engine does not parse yet;
        // hosted Turso applies them. Every 0093 statement must apply.
        if (own.has(statement.trim())) throw error;
        failures.push((error as Error).message);
      }
    }
    expect(failures.length).toBeLessThanOrEqual(2);
    await runCacheDepScenario({
      exec: async (sql) => { await database.exec(sql); },
      rows: async (sql) => await database.prepare(sql).all() as Array<Record<string, unknown>>,
    });
    await database.close();
  }, 60_000);
});
