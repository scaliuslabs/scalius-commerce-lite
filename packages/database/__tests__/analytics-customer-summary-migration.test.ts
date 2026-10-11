import { describe, expect, it } from "vitest";
import { generateAnalyticsCustomerSummaryTriggers, generateAnalyticsRollupTriggers } from "../scripts/analytics-rollup-triggers";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

describe("analytics customer currency extrema", () => {
  it.each([false, true])("stays exact across eligibility, identity, time and currency moves (reverse trigger order: %s)", (reverse) => {
    const db = createMigratedSqlite();
    try {
      if (reverse) {
        const triggers = [...generateAnalyticsRollupTriggers().filter((t) => !t.name.startsWith("analytics_facts_customer_summary_")), ...generateAnalyticsCustomerSummaryTriggers()];
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
        for (const trigger of [...triggers].reverse()) db.exec(`${trigger.sqlite};`);
      }
      db.exec(`INSERT INTO customers (id,name,phone) VALUES ('cus_a','A','+8801712345678'),('cus_b','B','+8801798765432')`);
      const insert = db.prepare(`INSERT INTO orders (id,customer_name,customer_phone,customer_id,shipping_address,city,zone,total_amount_minor,created_at,currency_code,shop_currency)
        VALUES (?,'Buyer','+8801712345678',?,'Road','city','zone',0,?,?,?)`);
      for (const [id, identity, time, currency] of [
        ['a1', 'cus_a', 100, 'BDT'], ['a2', 'cus_a', 100, 'BDT'], ['a3', 'cus_a', 300, 'BDT'],
        ['a4', 'cus_a', 300, 'BDT'], ['a5', 'cus_a', 400, 'BDT'], ['a6', 'cus_a', 500, 'BDT'],
        ['a7', 'cus_a', 600, 'BDT'], ['a8', 'cus_a', 700, 'BDT'], ['a9', 'cus_a', 700, 'BDT'],
        ['usd', 'cus_a', 50, 'USD'], ['b1', 'cus_b', 200, 'BDT'],
      ] as const) insert.run(id, identity, time, currency, currency);
      const summaries = () => db.prepare("SELECT * FROM analytics_customer_currency_summary ORDER BY identity,shop_currency").all();
      const assertSource = () => {
        const orders = db.prepare("SELECT customer_id,customer_phone,shop_currency,created_at FROM orders WHERE deleted_at IS NULL AND status NOT IN ('incomplete','cancelled')").all();
        const globalFirst = new Map<string, number>();
        const currencies = new Map<string, { identity: string; currency: string; times: number[] }>();
        for (const order of orders) {
          const identity = order.customer_id === null ? `p:${order.customer_phone}` : `c:${order.customer_id}`;
          const currency = String(order.shop_currency);
          const at = Number(order.created_at);
          globalFirst.set(identity, Math.min(globalFirst.get(identity) ?? Infinity, at));
          const key = JSON.stringify([identity, currency]);
          const group = currencies.get(key) ?? { identity, currency, times: [] };
          group.times.push(at);
          currencies.set(key, group);
        }
        const rows = summaries();
        expect(rows.filter((row) => row.first_sale_at !== null)).toHaveLength(currencies.size);
        for (const row of rows) {
          const times = currencies.get(JSON.stringify([row.identity, row.shop_currency]))?.times.sort((a, b) => a - b) ?? [];
          expect(row).toEqual({ identity: row.identity, shop_currency: row.shop_currency,
            first_sale_at: times[0] ?? null, second_sale_at: times[1] ?? null,
            third_sale_at: times[2] ?? null, fourth_sale_at: times[3] ?? null,
            penultimate_sale_at: times.at(-2) ?? null, third_last_sale_at: times.at(-3) ?? null, fourth_last_sale_at: times.at(-4) ?? null,
            last_sale_at: times.at(-1) ?? null, first_sale_any_currency_at: globalFirst.get(String(row.identity)) ?? null });
        }
      };
      assertSource();
      expect(summaries().find((row) => row.identity === 'c:cus_a' && row.shop_currency === 'BDT'))
        .toMatchObject({ first_sale_at: 100, second_sale_at: 100, third_sale_at: 300, fourth_sale_at: 300,
          last_sale_at: 700, penultimate_sale_at: 700, third_last_sale_at: 600, fourth_last_sale_at: 500, first_sale_any_currency_at: 50 });
      for (const statement of [
        "UPDATE orders SET status='cancelled' WHERE id='usd'",
        "UPDATE orders SET status='pending' WHERE id='usd'",
        "UPDATE orders SET created_at=400 WHERE id='usd'",
        "UPDATE orders SET shop_currency='JPY' WHERE id='a1'",
        "UPDATE orders SET customer_id='cus_b' WHERE id='a2'",
        "UPDATE orders SET deleted_at=1 WHERE id='a3'",
        "UPDATE orders SET deleted_at=NULL WHERE id='a3'",
        "DELETE FROM orders WHERE id='a1'",
        "UPDATE orders SET status='incomplete' WHERE customer_id='cus_a'",
      ]) {
        db.exec(statement);
        assertSource();
      }
      const before = summaries();
      db.exec("BEGIN; UPDATE orders SET status='pending',created_at=10 WHERE customer_id='cus_a'");
      assertSource();
      db.exec("ROLLBACK");
      expect(summaries()).toEqual(before);
    } finally { db.close(); }
  });

  it("does not write summaries for money-only changes or a sale between unchanged extrema", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(`INSERT INTO customers (id,name,phone) VALUES ('cus_a','A','+8801712345678')`);
      const insert = db.prepare(`INSERT INTO orders (id,customer_name,customer_phone,customer_id,shipping_address,city,zone,total_amount_minor,created_at)
        VALUES (?,'Buyer','+8801712345678','cus_a','Road','city','zone',0,?)`);
      for (const [index, time] of [100, 100, 100, 100, 300, 300, 300, 300].entries()) insert.run(index === 0 ? 'a' : `sale_${index}`, time);
      db.exec("CREATE TEMP TABLE summary_writes (n INTEGER)");
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TEMP TRIGGER count_summary_${event} AFTER ${event} ON analytics_customer_currency_summary BEGIN INSERT INTO summary_writes VALUES (1); END`);
      db.exec("UPDATE orders SET shipping_amount_minor=100 WHERE id='a'");
      insert.run('middle', 200);
      expect(db.prepare("SELECT count(*) AS n FROM summary_writes").get()).toEqual({ n: 0 });
      db.exec("INSERT INTO products (id,name,price_minor,slug) VALUES ('p_summary','Product',100,'summary')");
      const line = db.prepare("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price_minor,line_subtotal_minor) VALUES (?,'a','p_summary',1,100,100)");
      for (let index = 0; index < 99; index++) line.run(`line_${index}`);
      db.exec("UPDATE order_items SET line_subtotal_minor=101 WHERE order_id='a'");
      db.exec("INSERT INTO order_payments (id,order_id,payment_method,payment_type,status,amount_minor) VALUES ('refund_summary','a','manual','refund','refunded',10)");
      expect(db.prepare("SELECT count(*) AS n FROM summary_writes").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
