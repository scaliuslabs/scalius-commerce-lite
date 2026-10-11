import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION, renderAnalyticsCustomerEndpointsMigration } from "../scripts/analytics-customer-endpoints";
import { generateAnalyticsCustomerSummaryTriggers } from "../scripts/analytics-rollup-triggers";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const read = (name = ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION, provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("bounded customer sale endpoints migration", () => {
  it("reproduces both provider artifacts and keeps bounded single-statement triggers", () => {
    const sqlite = read();
    const ddl = statements(sqlite).filter((s) => /^(?:ALTER TABLE|DROP INDEX|CREATE INDEX) /i.test(s));
    const generated = renderAnalyticsCustomerEndpointsMigration(ddl);
    expect(generated.sqlite).toBe(sqlite);
    expect(generated.postgres).toBe(read(undefined, "postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 133)?.sourceSha256).toBe(generated.digest);
    for (const trigger of generateAnalyticsCustomerSummaryTriggers()) {
      expect(trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
      expect([...trigger.sqlite.matchAll(/offset (\d+)/gi)].every((match) => Number(match[1]) <= 3)).toBe(true);
    }
  });

  it.each(["SQLite", "Turso"])("backfills populated %s history without source writes and maintains duplicate endpoints", async (provider) => {
    const source = createMigratedSqlite({ beforeMigration: "0133_" });
    const database = provider === "Turso" ? await connect(":memory:") : source;
    try {
      if (provider === "Turso") {
        for (const table of ["orders", "order_items", "order_returns", "order_return_lines", "order_payments", "cod_tracking", "scalius_schema_migrations"]) {
          const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string };
          await database.exec(row.sql);
        }
        for (const statement of statements(read("0131_analytics_rollup"))) await database.exec(statement);
      }
      const times = [-1.5, -1.5, 2, 3, 5, 7, 8, 8, 9, 11];
      for (const [index, time] of times.entries()) await database.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,created_at)
        VALUES ('sale_${index}','Buyer','+8801712345678','Road','city','zone',${time})`);
      await database.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,created_at,currency_code,shop_currency)
        VALUES ('usd','Buyer','+8801712345678','Road','city','zone',-10,'USD','USD'),('dormant','Buyer','+8801798765432','Road','city','zone',1,'BDT','BDT')`);
      await database.exec("UPDATE orders SET status='cancelled' WHERE id='dormant'");
      const preserved = async () => Promise.all([
        ...["orders", "analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale"].map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),
        database.prepare("SELECT identity,shop_currency,first_sale_at,second_sale_at,last_sale_at,first_sale_any_currency_at FROM analytics_customer_currency_summary ORDER BY 1,2").all(),
        ...(provider === "SQLite" ? ["customers", "event_outbox", "cache_dep", "cache_clock"].map((table) => database.prepare(`SELECT * FROM ${table}`).all()) : []),
      ]);
      const before = await preserved();
      for (const statement of statements(read())) await database.exec(statement);
      expect(await preserved()).toEqual(before);
      const summary = () => database.prepare("SELECT * FROM analytics_customer_currency_summary WHERE identity='p:+8801712345678' AND shop_currency='BDT'").get();
      expect(await summary()).toMatchObject({ first_sale_at: -1.5, second_sale_at: -1.5, third_sale_at: 2, fourth_sale_at: 3,
        last_sale_at: 11, penultimate_sale_at: 9, third_last_sale_at: 8, fourth_last_sale_at: 8, first_sale_any_currency_at: -10 });
      const dormant = await database.prepare("SELECT third_sale_at,fourth_sale_at,penultimate_sale_at,third_last_sale_at,fourth_last_sale_at FROM analytics_customer_currency_summary WHERE identity='p:+8801798765432'").get();
      expect(dormant).toEqual({ third_sale_at: null, fourth_sale_at: null, penultimate_sale_at: null, third_last_sale_at: null, fourth_last_sale_at: null });
      await database.exec("UPDATE orders SET status='cancelled' WHERE id IN ('sale_0','sale_9')");
      expect(await summary()).toMatchObject({ first_sale_at: -1.5, second_sale_at: 2, third_sale_at: 3, fourth_sale_at: 5,
        last_sale_at: 9, penultimate_sale_at: 8, third_last_sale_at: 8, fourth_last_sale_at: 7 });
      const current = await summary();
      await database.exec("BEGIN; UPDATE orders SET created_at=50 WHERE id='sale_1'; ROLLBACK");
      expect(await summary()).toEqual(current);
      await database.exec("UPDATE orders SET status='cancelled' WHERE customer_phone='+8801712345678'");
      expect(await summary()).toMatchObject({ first_sale_at: null, second_sale_at: null, third_sale_at: null, fourth_sale_at: null,
        last_sale_at: null, penultimate_sale_at: null, third_last_sale_at: null, fourth_last_sale_at: null, first_sale_any_currency_at: null });
    } finally {
      if (provider === "Turso") await database.close();
      source.close();
    }
  });
});
