// Migration 0167: a limited promotion's redemptions advance its cache key only
// when one exhausts it (or a removed one un-exhausts it), with the guard in
// the trigger's WHEN clause. It reinstalls the two generated triggers verbatim
// over a store migrated through 0165, where every redemption advanced the key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0167_promotion_exhaustion_dependency";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("re-installs the redemption insert and delete triggers verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(triggers.map((trigger) => trigger.name)).toEqual(["cdep_promotion_redemptions_ins", "cdep_promotion_redemptions_del"]);
    for (const trigger of triggers) {
      expect(migration(), trigger.name).toContain(`DROP TRIGGER IF EXISTS \`${trigger.name}\`;`);
      expect(migration(), trigger.name).toContain(`${trigger.sqlite};`);
      expect(migration("postgres/"), trigger.name).toContain(`DROP TRIGGER IF EXISTS "${trigger.name}" ON "promotion_redemptions";`);
      expect(migration("postgres/"), trigger.name).toContain(`${trigger.postgres};`);
    }
  });

  it("keeps every statement remote-D1 safe: the guard in WHEN, one statement per body", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/\bCASE\b/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated store`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;

  it("stops advancing a capped promotion on redemptions that leave it open", () => {
    db = createMigratedSqlite({ beforeMigration: "0167_", foreignKeys: false });
    // The checkout guards on redemptions (allocations, eligibility) are not under test here.
    for (const { name } of db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'promotion_redemptions' AND name NOT LIKE 'cdep\\_%' ESCAPE '\\'",
    ).all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name}"`);
    db.exec("INSERT INTO promotions (id, name, method, status, max_redemptions) VALUES ('promo_cap', 'Capped', 'code', 'active', 2)");
    const redeem = (id: string) => db!.exec(`INSERT INTO promotion_redemptions
      (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code, currency_code, discount_amount_minor)
      VALUES ('${id}', 'promo_cap', 'order_${id}', 'cust_1', 1, 'SAVE10', 'BDT', 500)`);

    // Before 0167 every redemption of a limited promotion advanced it.
    redeem("r0");
    const advancedBefore = dep("promo:promo_cap");
    expect(advancedBefore).toBeGreaterThan(0);
    db.exec("DELETE FROM promotion_redemptions WHERE id = 'r0'");

    db.exec(compiledMigrationSql("d1", undefined, "0167_"));
    const before = dep("promo:promo_cap");
    redeem("r1");
    expect(dep("promo:promo_cap")).toBe(before);
    redeem("r2");
    expect(dep("promo:promo_cap")).toBeGreaterThan(before);
  }, 120_000);
});
