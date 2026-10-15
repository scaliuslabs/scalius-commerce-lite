import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { nextOrderNumberSql } from "../src/client";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "../src/testing/postgres-native";
import { POSTGRES_ORDER_NUMBER_SEQUENCE_SQL } from "../scripts/postgres-schema";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("PostgreSQL order numbering", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("initializes above imported orders, never rewinds, and allocates concurrent inserts", async () => {
    const { db, client } = await createNativePostgres({ label: "order_numbers" });
    const insert = (id: string) => db.run(sql`
      INSERT INTO orders (id, order_number, customer_name, customer_phone, requires_shipping)
      VALUES (${id}, ${nextOrderNumberSql(db)}, 'Buyer', '+8801712345678', 0)
    `);
    await insert("first");
    expect((await client.query("SELECT order_number::integer AS number FROM orders")).rows).toEqual([{ number: 1001 }]);

    // The same DDL runs after a portable import and as the upgrade sidecar.
    const migration = readFileSync(new URL("../migrations/postgres/0154_order_number_sequence.sql", import.meta.url), "utf8");
    expect(migration.split("--> statement-breakpoint").slice(0, -1).map((part) => part.trim()))
      .toEqual([...POSTGRES_ORDER_NUMBER_SEQUENCE_SQL]);
    await client.query("INSERT INTO orders (id, order_number, customer_name, customer_phone, requires_shipping) VALUES ('historical', 8123, 'Buyer', '+8801712345678', 0)");
    await client.query("BEGIN");
    for (const statement of POSTGRES_ORDER_NUMBER_SEQUENCE_SQL) await client.query(statement);
    await client.query("COMMIT");
    await insert("after_import");
    expect((await client.query("SELECT order_number::integer AS number FROM orders WHERE id = 'after_import'")).rows).toEqual([{ number: 8124 }]);

    // Rollback consumes a sequence value, and replay cannot reissue it.
    await client.query("BEGIN");
    const consumed = Number((await client.query("SELECT nextval('scalius_compat.order_number_seq') AS number")).rows[0].number);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    for (const statement of POSTGRES_ORDER_NUMBER_SEQUENCE_SQL) await client.query(statement);
    await client.query("COMMIT");
    await insert("after_replay");
    expect(Number((await client.query("SELECT order_number FROM orders WHERE id = 'after_replay'")).rows[0].order_number)).toBe(consumed + 1);

    // Sixteen independent SERIALIZABLE adapter transactions share no maximum read.
    await Promise.all(Array.from({ length: 16 }, (_, index) => insert(`parallel_${index}`)));
    const rows = (await client.query("SELECT order_number FROM orders WHERE id LIKE 'parallel_%'")).rows;
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((row) => row.order_number)).size).toBe(16);
  });
});
