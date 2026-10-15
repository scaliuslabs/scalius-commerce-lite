import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nextOrderNumberSql } from "../src/client";
import { createSqliteD1Database, createSqliteTursoDatabase } from "../src/testing/sqlite-d1";

describe.each(["d1", "turso"] as const)("%s order numbering", (provider) => {
  it("allocates above historical numbers inside the insert and rolls back with it", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, order_number INTEGER UNIQUE)");
      const db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
      const insert = (id: string) => db.run(sql`INSERT INTO orders (id, order_number) VALUES (${id}, ${nextOrderNumberSql(db)})`);
      await insert("first");
      expect(sqlite.prepare("SELECT order_number FROM orders").get()).toEqual({ order_number: 1001 });
      sqlite.exec("INSERT INTO orders VALUES ('historical', 8123)");
      await expect(insert("first")).rejects.toThrow();
      await insert("next");
      expect(sqlite.prepare("SELECT order_number FROM orders WHERE id = 'next'").get()).toEqual({ order_number: 8124 });
    } finally {
      sqlite.close();
    }
  });
});
