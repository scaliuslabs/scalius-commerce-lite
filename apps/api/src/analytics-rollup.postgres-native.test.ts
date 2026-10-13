import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { analyticsFactMeasureSql } from "@scalius/database/analytics-rollup";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { createAnalyticsContext, getAnalyticsOverviewForRequest } from "@scalius/core/modules/analytics";
import { pruneStaffAlerts } from "@scalius/core/modules/notifications";
import { maintainDerivedProjections } from "./scheduled/derived-projections";
import { createAnalyticsFixture, type AnalyticsFixture } from "../../../packages/core/src/modules/analytics/reports/reports.fixture";
import { AUGUST } from "../../../packages/core/src/modules/analytics/reports/metrics.fixture-store";
import { sourceOverviewPeriod } from "../../../packages/core/src/modules/analytics/reports/overview.source-oracle";
import { assertRollupProjection, sealEveryFactDay } from "../../../packages/core/src/modules/analytics/reports/overview-rollup.assertions";

afterAll(closeNativePostgres);

async function copyFixture(client: Client, fixture: AnalyticsFixture) {
  const tables = fixture.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'").all();
  const existing = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((row) => row.table_name));
  await client.query("SET session_replication_role = replica");
  try {
    for (const { name } of tables) {
      if (!existing.has(name)) continue;
      const rows = fixture.sqlite.prepare(`SELECT * FROM "${name}"`).all();
      if (!rows.length) continue;
      await client.query(`DELETE FROM "${name}"`);
      for (const row of rows) {
        const columns = Object.keys(row);
        await client.query(`INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
      }
    }
  } finally {
    await client.query("SET session_replication_role = DEFAULT");
  }
}

/** Two orders of one guest on 15 August; the projection is copied with every day sealed. */
async function seed(client: Client, extra?: (fixture: AnalyticsFixture) => void, committedMutations: readonly string[] = []) {
  const fixture = createAnalyticsFixture();
  try {
    for (const id of ["race_a", "race_b"]) {
      fixture.order({ id, createdAt: "2026-08-15T12:00:00Z", status: "delivered", customerPhone: "+8801799990000",
        lines: [
          { id: `${id}_1`, productId: "p_race", quantity: 5, unitMinor: 101 },
          { id: `${id}_2`, productId: "p_race", quantity: 5, unitMinor: 103 },
        ] });
      for (const suffix of ["1", "2"]) fixture.payment({ id: `${id}_refund_${suffix}`, orderId: id, amountMinor: 11, type: "refund", status: "refunded" });
    }
    fixture.returnCase({ id: "race_return", orderId: "race_a", status: "approved", lines: [
      { itemId: "race_a_1", requested: 3, approved: 1 },
      { itemId: "race_a_2", requested: 3, approved: 1 },
    ] });
    extra?.(fixture);
    await sealEveryFactDay(fixture.db);
    // Copy valid D1 rows; the contention below exercises the live PostgreSQL triggers.
    await copyFixture(client, fixture);
    for (const statement of committedMutations) fixture.sqlite.exec(statement);
    return await sourceOverviewPeriod(await createAnalyticsContext(fixture.db, "Asia/Dhaka"), AUGUST);
  } finally {
    fixture.close();
  }
}

type Outcome = { ok: true } | { ok: false; code: string };
async function outcome(operation: Promise<unknown>): Promise<Outcome> {
  try { await operation; return { ok: true }; }
  catch (error) { return { ok: false, code: String((error as { code?: string }).code) }; }
}

async function begin(client: Client) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SET LOCAL lock_timeout = '10s'");
  // Both transactions observe the old orders, before either changes a child.
  await client.query("SELECT id FROM orders WHERE id IN ('race_a', 'race_b')");
}

/** The overview equals the source query, and the projection a rebuild, before and after sealing. */
async function expectExact(pg: Awaited<ReturnType<typeof createNativePostgres>>, expected: unknown) {
  const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
  const read = async () => (await getAnalyticsOverviewForRequest(ctx, { ...AUGUST, comparison: "none" })).current;
  expect(await read()).toEqual(expected);
  await assertRollupProjection(pg.db);
  await sealEveryFactDay(pg.db);
  await assertRollupProjection(pg.db);
  expect(await read()).toEqual(expected);
  return read();
}

const races = [
  { name: "different lines", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_2'" },
  { name: "reversed line commit order", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_2'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_1'" },
  { name: "first writer rolls back", rollback: true, left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_2'" },
  { name: "different refunds", left: "UPDATE order_payments SET amount_minor = amount_minor + 11 WHERE id = 'race_a_refund_1'", right: "UPDATE order_payments SET amount_minor = amount_minor + 7 WHERE id = 'race_a_refund_2'" },
  { name: "different return lines", left: "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'race_return_l0'", right: "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'race_return_l1'" },
  { name: "different orders unsealing one day", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_b_1'" },
  { name: "date moves out of one sealed day", left: "UPDATE orders SET created_at = created_at - 86400 WHERE id = 'race_a'", right: "UPDATE orders SET created_at = created_at + 86400 WHERE id = 'race_b'" },
];

describe.runIf(nativePostgresUrl())("analytics rollup SERIALIZABLE concurrency", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it.each(races)("keeps exact facts and sealed days when $name contend", async (race) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pg = await createNativePostgres({ label: "analytics_rollup" });
    const left = new Client({ connectionString: pg.url });
    const right = new Client({ connectionString: pg.url });
    try {
      await left.connect();
      await right.connect();
      const expected = await seed(pg.client, undefined, [...(race.rollback ? [] : [race.left]), race.right]);
      const rightPid = Number((await right.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await begin(left);
      await begin(right);
      await left.query(race.left);
      let settled = false;
      const pending = outcome(right.query(race.right)).then((result) => { settled = true; return result; });
      // Prove overlap by observing an actual database lock wait, not a sleep.
      let blocked = false;
      const deadline = performance.now() + 5_000;
      while (!settled && performance.now() < deadline) {
        const row = (await pg.client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [rightPid])).rows[0];
        if (row?.wait_event_type === "Lock") { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await left.query(race.rollback ? "ROLLBACK" : "COMMIT");
      let result = await pending;
      // A pre-lock serialization failure is also a valid conflict detection.
      expect(blocked || (!result.ok && ["40001", "40P01"].includes(result.code))).toBe(true);
      if (result.ok) result = await outcome(right.query("COMMIT"));
      if (!result.ok) {
        expect(["40001", "40P01"]).toContain(result.code);
        await right.query("ROLLBACK");
        // Retry the whole operation with a fresh snapshot, matching the adapter.
        await begin(right);
        await right.query(race.right);
        await right.query("COMMIT");
      }
      const current = await expectExact(pg, expected);
      expect(current.totals.orders).toBe(2);
      expect(current.customers).toEqual({ customers: 1, newCustomers: 1, returningCustomers: 0, repeatPurchaseRate: 100 });
      if (race.rollback) {
        expect(Number((await pg.client.query("SELECT line_subtotal_minor FROM order_items WHERE id = 'race_a_1'")).rows[0].line_subtotal_minor)).toBe(505);
        expect(Number((await pg.client.query("SELECT line_subtotal_minor FROM order_items WHERE id = 'race_a_2'")).rows[0].line_subtotal_minor)).toBe(522);
      }
    } finally {
      await left.query("ROLLBACK").catch(() => undefined);
      await right.query("ROLLBACK").catch(() => undefined);
      await left.end();
      await right.end();
      log.mockRestore();
    }
  });

  it("lets concurrent checkouts on an unsealed day commit without a shared projection row", async () => {
    const pg = await createNativePostgres({ label: "analytics_checkouts" });
    await pg.client.query("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_checkout', 'Checkout', 'checkout', 100, 1)");
    // Isolate the projection: the cache dependency clock is a separate, known hot row.
    for (const { tgname, tbl } of (await pg.client.query(`SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('orders', 'order_items') AND tgname LIKE 'cdep_%'`)).rows) {
      await pg.client.query(`DROP TRIGGER "${tgname}" ON ${tbl}`);
    }
    const clients = await Promise.all(["one", "two"].map(async (name) => {
      const client = new Client({ connectionString: pg.url });
      await client.connect();
      await client.query(`INSERT INTO customers (id, name, phone) VALUES ('cus_${name}', 'Buyer', '+880170000${name === "one" ? 1 : 2}000')`);
      return { client, name };
    }));
    const now = Math.floor(Date.now() / 1000);
    try {
      for (const { client } of clients) await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      for (const { client, name } of clients) {
        await client.query(`INSERT INTO orders (id, customer_name, customer_phone, customer_id, shipping_address, city, zone, city_name,
          currency_code, subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor,
          shop_currency, subtotal_shop_minor, shipping_shop_minor, discount_shop_minor, tax_shop_minor, total_shop_minor,
          status, payment_method, payment_status, paid_amount_minor, balance_due_minor, fulfillment_status, channel, created_at, updated_at)
          VALUES ('ord_${name}', 'Buyer', '+8801700000000', 'cus_${name}', 'Road 1', 'city', 'zone', 'Dhaka', 'BDT', 200, 0, 0, 0, 200,
          'BDT', 200, 0, 0, 0, 200, 'pending', 'cod', 'unpaid', 0, 200, 'pending', 'online_store', ${now}, ${now})`);
        for (const line of [1, 2]) {
          await client.query(`INSERT INTO order_items (id, order_id, product_id, quantity, product_name, unit_price_minor, line_subtotal_minor, fulfillment_type, created_at)
            VALUES ('ord_${name}_${line}', 'ord_${name}', 'p_checkout', 1, 'Checkout', 100, 100, 'ship', ${now})`);
        }
      }
      for (const { client } of clients) expect(await outcome(client.query("COMMIT"))).toEqual({ ok: true });
      await assertRollupProjection(pg.db);
      expect((await pg.client.query("SELECT count(*) AS n FROM analytics_sales_buckets")).rows[0].n).toBe(0);
    } finally {
      for (const { client } of clients) {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    }
  });

  it("keeps facts exact through eligibility, date, identity and currency changes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixture = createAnalyticsFixture();
    try {
      const pg = await createNativePostgres({ label: "analytics_customers" });
      fixture.customer("timeline_registered", "Registered", "+8801799999900");
      for (const [id, createdAt, currencyCode, customerPhone, status] of [
        ["history_usd", "2026-07-01T12:00:00Z", "USD", NO_PHONE, "cancelled"],
        ["history_a", "2026-08-10T12:00:00Z", "BDT", NO_PHONE, "cancelled"],
        ["history_b", "2026-08-10T12:00:00Z", "BDT", NO_PHONE, "cancelled"],
        ["history_c", "2026-08-11T12:00:00Z", "BDT", NO_PHONE, "cancelled"],
        ["gap_before", "2026-07-01T12:00:00Z", "BDT", "+8801799999901", "delivered"],
        ["gap_after", "2026-09-01T12:00:00Z", "BDT", "+8801799999901", "delivered"],
        ["gap_middle", "2026-08-15T12:00:00Z", "BDT", "+8801799999901", "cancelled"],
        ["filler_a", "2026-08-12T12:00:00Z", "BDT", "+8801799999902", "delivered"],
        ["filler_b", "2026-08-13T12:00:00Z", "BDT", "+8801799999902", "delivered"],
      ] as const) fixture.order({ id, createdAt, currencyCode, customerPhone, status, requiresShipping: false,
        lines: [{ id: `${id}_line`, productId: "p_timeline", quantity: 1, unitMinor: 101, fulfillmentType: "digital" }] });
      await sealEveryFactDay(fixture.db);
      await copyFixture(pg.client, fixture);
      const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
      const sourceCtx = await createAnalyticsContext(fixture.db, "Asia/Dhaka");
      const parity = async () => {
        await assertRollupProjection(pg.db);
        for (const code of ["BDT", "USD"]) {
          const expected = await sourceOverviewPeriod({ ...sourceCtx, currency: { ...sourceCtx.currency, code } }, AUGUST);
          const actual = (await getAnalyticsOverviewForRequest({ ...ctx, currency: { ...ctx.currency, code } }, { ...AUGUST, comparison: "none" })).current;
          expect(actual).toEqual(expected);
        }
      };
      await parity();
      for (const statement of [
        `UPDATE orders SET status = 'delivered' WHERE customer_phone = '${NO_PHONE}'`,
        `UPDATE orders SET created_at = ${fixture.epoch("2026-09-05T12:00:00Z")} WHERE id = 'history_usd'`,
        `UPDATE orders SET created_at = ${fixture.epoch("2026-07-01T12:00:00Z")} WHERE id = 'history_usd'`,
        "UPDATE orders SET deleted_at = 123 WHERE id = 'history_usd'",
        "UPDATE orders SET deleted_at = NULL WHERE id = 'history_usd'",
        "UPDATE orders SET shop_currency = 'USD', currency_code = 'USD' WHERE id = 'history_a'",
        "UPDATE orders SET customer_id = 'timeline_registered' WHERE id IN ('history_b', 'history_c')",
        "UPDATE orders SET customer_id = NULL WHERE id = 'history_b'",
        "UPDATE orders SET status = 'delivered' WHERE id = 'gap_middle'",
        "DELETE FROM orders WHERE id = 'gap_middle'",
      ]) {
        await pg.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        try {
          await pg.client.query(statement);
          await pg.client.query("COMMIT");
        } catch (error) {
          await pg.client.query("ROLLBACK");
          throw error;
        }
        fixture.sqlite.exec(statement);
        await parity();
        await sealEveryFactDay(pg.db);
        await parity();
      }
      // The projection checks and retention run on PostgreSQL too: in step, nothing to repair.
      expect(await maintainDerivedProjections(pg.db, { now: new Date("2026-10-01T00:00:00Z") })).toMatchObject({
        analytics: { drift: 0 }, recommendations: { drift: 0 }, inbox: { drift: 0 } });
      expect((await maintainDerivedProjections(pg.db, { rebuild: true })).done).toBe(true);
      await parity();
      expect(await pruneStaffAlerts(pg.db, Math.floor(Date.now() / 1000))).toEqual({ inbox: 0, alerts: 0 });
    } finally {
      fixture.close();
      log.mockRestore();
    }
  });

  it("rounds FX half ties away from zero per line and sums refunds before conversion", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pg = await createNativePostgres({ label: "analytics_fx" });
      const expected = await seed(pg.client, (fixture) => {
        for (const [id, tax] of [["fx_positive", 0], ["fx_negative", 10]] as const) {
          fixture.order({ id, createdAt: "2026-08-20T12:00:00Z", currencyCode: "USD", cityName: id,
            pricesIncludeTax: true, lines: [
              { id: `${id}_1`, productId: "p_fx", quantity: 1, unitMinor: 5, taxMinor: tax },
              { id: `${id}_2`, productId: "p_fx", quantity: 1, unitMinor: 5, taxMinor: tax },
            ] });
          fixture.sqlite.prepare("UPDATE orders SET shop_currency = 'BDT', fx_rate = '0.5' WHERE id = ?").run(id);
          fixture.payment({ id: `${id}_refund_1`, orderId: id, amountMinor: 1, type: "refund", status: "refunded" });
          fixture.payment({ id: `${id}_refund_2`, orderId: id, amountMinor: 1, type: "refund", status: "refunded" });
        }
      });
      // Recompute on PostgreSQL; a copied D1 projection alone would hide the bug.
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 2 WHERE order_id IN ('fx_positive', 'fx_negative')");
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor - 2 WHERE order_id IN ('fx_positive', 'fx_negative')");
      await pg.client.query("UPDATE orders SET fx_rate = '0.25' WHERE id IN ('fx_positive', 'fx_negative')");
      await pg.client.query("UPDATE orders SET fx_rate = '0.5' WHERE id IN ('fx_positive', 'fx_negative')");
      const actual = await expectExact(pg, expected);
      expect(actual.breakdowns.city.find((row) => row.key === "fx_positive")?.grossSales).toBe(6);
      expect(actual.breakdowns.city.find((row) => row.key === "fx_negative")?.grossSales).toBe(-6);
      expect((await pg.client.query(`SELECT ${analyticsFactMeasureSql("f").refunded} AS refunded FROM analytics_order_facts f WHERE order_id = 'fx_positive'`)).rows[0].refunded).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("truncates partial-return minor units after PostgreSQL quantity aggregation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pg = await createNativePostgres({ label: "analytics_partial_return" });
      // The case is approved on PostgreSQL: its status trigger moves the line's accepted units.
      const approve = ["UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'partial_return_l0'",
        "UPDATE order_returns SET status = 'approved' WHERE id = 'partial_return'"];
      const expected = await seed(pg.client, (fixture) => {
        fixture.order({ id: "partial", createdAt: "2026-08-20T12:00:00Z", status: "delivered", cityName: "partial",
          lines: [{ id: "partial_line", productId: "p_partial", quantity: 3, unitMinor: 101, discountMinor: 11, taxMinor: 31 }] });
        fixture.returnCase({ id: "partial_return", orderId: "partial", status: "requested", lines: [{ itemId: "partial_line", requested: 3, approved: 0 }] });
      }, approve);
      for (const statement of approve) await pg.client.query(statement);
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 3 WHERE id = 'partial_line'");
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor - 3 WHERE id = 'partial_line'");
      const actual = await expectExact(pg, expected);
      expect(actual.breakdowns.city.find((row) => row.key === "partial")).toMatchObject({ returns: 194, taxes: 11, totalSales: 109 });
    } finally {
      log.mockRestore();
    }
  });
});
