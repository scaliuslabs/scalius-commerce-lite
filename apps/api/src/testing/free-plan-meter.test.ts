import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFreePlanMeter, createScanEstimator, parseTrigger, writeTarget } from "./free-plan-meter";

describe("Free plan measurement boundaries", () => {
  it("includes waitUntil work and keeps later setup out of the completed measurement", async () => {
    const d1 = {
      prepare: () => ({ run: async () => ({ success: true, results: [], meta: { changes: 1 } }) }),
    } as unknown as D1Database;
    const meter = createFreePlanMeter({ d1 });
    const write = () => meter.bindings.DB!.prepare("INSERT INTO example VALUES (1)").run();

    const first = await meter.measure(async () => {
      await write();
      meter.ctx.waitUntil(Promise.resolve().then(write));
    });
    expect(first.counters).toMatchObject({ d1Calls: 2, d1Statements: 2, waitUntilTasks: 1 });
    const completed = { ...first.counters };

    // The budget runner prepares the next order outside its measurement.
    await write();
    await meter.cache.match("https://shop.test/setup");
    expect(first.counters).toEqual(completed);

    const second = await meter.measure(write);
    expect(second.counters).toMatchObject({ d1Calls: 1, d1Statements: 1, cacheOps: 0, waitUntilTasks: 0 });
    expect(first.counters).toEqual(completed);
  });

  it("counts the scans of the triggers a write can fire, nested writes included", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, price INTEGER);
      CREATE TABLE notes (id TEXT, body TEXT);
      CREATE TABLE log (id TEXT);
      CREATE TABLE audit (id TEXT);
      INSERT INTO notes VALUES ('a', 'x'), ('b', 'y'), ('c', 'z');
      INSERT INTO audit VALUES ('1'), ('2');
      CREATE TRIGGER items_ins AFTER INSERT ON items
      WHEN EXISTS (SELECT 1 FROM notes WHERE body = NEW.name)
      BEGIN INSERT INTO log SELECT NEW.id; END;
      CREATE TRIGGER items_price AFTER UPDATE OF price ON items
      BEGIN SELECT RAISE(ABORT, 'no') WHERE NEW.price < 0; INSERT INTO log SELECT id FROM notes WHERE body = OLD.name; END;
      CREATE TRIGGER log_ins AFTER INSERT ON log BEGIN INSERT INTO audit SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM audit WHERE id = NEW.id); END;
    `);
    const known = new Set(["items", "notes", "log", "audit"]);
    expect(writeTarget(`INSERT INTO "items" ("id") VALUES (?) ON CONFLICT ("id") DO UPDATE SET "price" = excluded."price"`, known))
      .toEqual({ table: "items", events: new Set(["INSERT", "UPDATE"]), columns: ["price"] });
    expect(writeTarget(`UPDATE "items" SET "name" = ?, "price" = coalesce(?, 1) WHERE "id" = ?`, known))
      .toEqual({ table: "items", events: new Set(["UPDATE"]), columns: ["name", "price"] });
    expect(writeTarget("SELECT * FROM items", known)).toBeNull();
    expect(parseTrigger("CREATE TRIGGER t AFTER UPDATE OF `price`, name ON `items` FOR EACH ROW BEGIN SELECT 1; END")?.columns).toEqual(["price", "name"]);

    const estimator = createScanEstimator(sqlite);
    // The insert's guard scans notes, its log write fires log_ins, whose guard scans audit.
    expect(estimator.estimate("INSERT INTO items (id, name) VALUES ('i', 'x')", 1)).toEqual({ scans: 2, rows: 5 });
    // A write that changed nothing fires nothing; a read never does.
    expect(estimator.estimate("INSERT INTO items (id, name) VALUES ('i', 'x')", 0)).toEqual({ scans: 0, rows: 0 });
    // Only an update of `price` fires items_price (its body scans notes, then log_ins scans audit).
    expect(estimator.estimate("UPDATE items SET name = 'q' WHERE id = 'i'", 1)).toEqual({ scans: 0, rows: 0 });
    expect(estimator.estimate("UPDATE items SET price = 2 WHERE id = 'i'", 1)).toEqual({ scans: 2, rows: 5 });
    sqlite.close();
  });
});
