// Migration 0169: a SKU's band triggers (`cdep_product_variants_band` and
// its old-image companion) read the store's default low-stock level once per
// update, in a FROM subquery both bands read, instead of at every use. It
// reinstalls the generated triggers verbatim; over the same writes the band
// trigger fires exactly when deployed 0100's did, and parses the settings
// document once instead of up to four times.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { cacheDepTriggersForMigration, renderCacheDepMigration } from "../scripts/cache-dep-triggers";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const NAME = "0169_fk_indexes_and_trigger_guards";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");
const BAND = "cdep_product_variants_band";

const reinstalled = cacheDepTriggersForMigration(NAME);
const current = reinstalled.find((trigger) => trigger.name === BAND);
const deployedSql = (name: string) => splitSchemaMigrationStatements(renderCacheDepMigration().sqlite)
  .find((statement) => statement.startsWith(`CREATE TRIGGER \`${name}\` `))!.replace(/;$/, "");
const deployed = deployedSql(BAND);

/** The band trigger over a bare SKU table, with the settings row and the cache tables it reads and writes. */
function store(triggerSql: string) {
  const db = new DatabaseSync(":memory:");
  let parses = 0;
  // Counts the settings document reads: the store default's only json_valid call.
  db.function("json_valid", (value) => {
    parses += 1;
    try { JSON.parse(String(value)); return 1; } catch { return 0; }
  });
  db.exec(`CREATE TABLE product_variants (id TEXT PRIMARY KEY, product_id TEXT, stock INTEGER, reserved_stock INTEGER, track_inventory INTEGER, low_stock_threshold INTEGER);
    CREATE TABLE settings (category TEXT, key TEXT, value TEXT);
    CREATE TABLE cache_dep (dep TEXT PRIMARY KEY, seq INTEGER);
    CREATE TABLE cache_clock (id INTEGER PRIMARY KEY, seq INTEGER, floor INTEGER, coarse INTEGER);
    INSERT INTO cache_clock VALUES (1, 0, 0, 0);
    INSERT INTO product_variants VALUES ('sku', 'prod', 10, 0, 1, NULL);`);
  db.exec(triggerSql);
  const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  return {
    db,
    /** Whether the write advanced the product's key, and how many settings parses it cost. */
    write(sql: string, ...values: Array<number | string | null>): { fired: boolean; parses: number } {
      const [before, parsed] = [changes(), parses];
      db.prepare(sql).run(...values);
      db.exec("DELETE FROM cache_dep");
      return { fired: changes() - before > 2, parses: parses - parsed };
    },
  };
}

describe(`${NAME}: the band trigger`, () => {
  it("is reinstalled verbatim on every provider, and deployed 0100 keeps its text", () => {
    expect(reinstalled.map((trigger) => trigger.name)).toEqual([BAND, `${BAND}_old`]);
    const baseline = readFileSync(join(import.meta.dirname, "../migrations/0100_cache_dependencies.sql"), "utf8");
    for (const trigger of reinstalled) {
      expect(migration()).toContain(`DROP TRIGGER IF EXISTS \`${trigger.name}\`;`);
      expect(migration()).toContain(`${trigger.sqlite};`);
      expect(migration("postgres/")).toContain(`DROP TRIGGER IF EXISTS "${trigger.name}" ON "product_variants";`);
      expect(migration("postgres/")).toContain(`${trigger.postgres};`);
      expect(trigger.sqlite).not.toMatch(/\bCASE\b/);
      expect(trigger.sqlite.match(/defaultLowStockThreshold/g)).toHaveLength(1);
      expect(deployedSql(trigger.name).match(/defaultLowStockThreshold/g)).toHaveLength(4);
      expect(baseline).toContain(`${deployedSql(trigger.name)};`);
    }
  });

  it("fires on exactly the writes deployed 0100's guard fired on, reading the store default once", () => {
    const before = store(deployed);
    const after = store(current!.sqlite);
    const defaults = [null, "{}", '{"defaultLowStockThreshold":5}', '{"defaultLowStockThreshold":0}', '{"defaultLowStockThreshold":-2}', "not json"];
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let parsesBefore = 0;
    let parsesAfter = 0;
    for (let step = 0; step < 600; step += 1) {
      if (step % 40 === 0) {
        const value = defaults[random(defaults.length)]!;
        for (const { db } of [before, after]) {
          db.exec("DELETE FROM settings");
          if (value !== null) db.prepare("INSERT INTO settings VALUES ('inventory', 'document', ?)").run(value);
        }
      }
      const [column, value] = [
        ["stock", random(12)],
        ["reserved_stock", random(6)],
        ["track_inventory", random(2)],
        ["low_stock_threshold", random(3) === 0 ? null : random(8) - 1],
      ][random(4)] as [string, number | null];
      const sql = `UPDATE product_variants SET ${column} = ? WHERE id = 'sku'`;
      const a = before.write(sql, value);
      const b = after.write(sql, value);
      expect(b.fired, `step ${step}: ${column} = ${value}`).toBe(a.fired);
      expect(b.parses).toBeLessThanOrEqual(1);
      parsesBefore += a.parses;
      parsesAfter += b.parses;
    }
    expect(parsesAfter).toBeLessThan(parsesBefore);
    before.db.close();
    after.db.close();
  });
});
