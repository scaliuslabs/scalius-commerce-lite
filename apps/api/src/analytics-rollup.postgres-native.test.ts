import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { createAnalyticsContext, getAnalyticsOverviewForRequest } from "@scalius/core/modules/analytics";
import { createAnalyticsFixture, type AnalyticsFixture } from "../../../packages/core/src/modules/analytics/reports/reports.fixture";
import { AUGUST } from "../../../packages/core/src/modules/analytics/reports/metrics.fixture-store";
import { sourceOverviewPeriod } from "../../../packages/core/src/modules/analytics/reports/overview.source-oracle";
import { assertRollupProjection } from "../../../packages/core/src/modules/analytics/reports/overview-rollup.assertions";

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

async function assertCustomerTimelines(client: Client) {
  const orders = (await client.query(`SELECT shop_currency, created_at,
    CASE WHEN customer_id IS NOT NULL THEN 'c:' || customer_id ELSE 'p:' || customer_phone END AS identity
    FROM orders WHERE deleted_at IS NULL AND status NOT IN ('incomplete', 'cancelled')
    ORDER BY created_at, id`)).rows;
  const summaries = (await client.query("SELECT * FROM analytics_customer_currency_summary")).rows;
  for (const order of orders) {
    expect(summaries.some((row) => row.identity === order.identity && row.shop_currency === order.shop_currency)).toBe(true);
  }
  for (const row of summaries) {
    const history = orders.filter((order) => order.identity === row.identity);
    const currencyHistory = history.filter((order) => order.shop_currency === row.shop_currency);
    expect(row).toEqual({
      identity: row.identity, shop_currency: row.shop_currency,
      first_sale_at: currencyHistory[0]?.created_at ?? null,
      second_sale_at: currencyHistory[1]?.created_at ?? null,
      last_sale_at: currencyHistory.at(-1)?.created_at ?? null,
      first_sale_any_currency_at: history[0]?.created_at ?? null,
    });
  }
}

async function seed(client: Client, extra?: (fixture: AnalyticsFixture) => void, committedMutations: readonly string[] = []) {
  const fixture = createAnalyticsFixture();
  try {
    for (const id of ["race_a", "race_b"]) {
      fixture.order({ id, createdAt: "2026-08-15T12:00:00Z", status: "delivered", customerPhone: "NO_PHONE",
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
    // Like the existing analytics provider-parity suite, copy valid D1 rows;
    // the contention below exercises the live PostgreSQL maintenance triggers.
    await copyFixture(client, fixture);
    // Expected final state uses SQLite's independent pre-rollup SQL. Running
    // that legacy SQL on PG would retain its former numeric-division bug.
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
  // Both transactions observe the old order, before either changes a child.
  await client.query("SELECT id FROM orders WHERE id IN ('race_a', 'race_b')");
}

const races = [
  { name: "different lines", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_2'" },
  { name: "reversed line commit order", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_2'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_1'" },
  { name: "first writer rolls back", rollback: true, left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_a_2'" },
  { name: "different refunds", left: "UPDATE order_payments SET amount_minor = amount_minor + 11 WHERE id = 'race_a_refund_1'", right: "UPDATE order_payments SET amount_minor = amount_minor + 7 WHERE id = 'race_a_refund_2'" },
  { name: "different return lines", left: "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'race_return_l0'", right: "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'race_return_l1'" },
  { name: "different orders sharing buckets", left: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 11 WHERE id = 'race_a_1'", right: "UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 7 WHERE id = 'race_b_1'" },
  { name: "same-identity customer timelines", left: "UPDATE orders SET created_at = created_at - 86400 WHERE id = 'race_a'", right: "UPDATE orders SET created_at = created_at + 86400 WHERE id = 'race_b'" },
];

describe.runIf(nativePostgresUrl())("analytics rollup SERIALIZABLE concurrency", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it.each(races)("keeps exact facts and buckets when $name contend", async (race) => {
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
      const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
      const current = (await getAnalyticsOverviewForRequest(ctx, { ...AUGUST, comparison: "none" })).current;
      expect(current).toEqual(expected);
      const facts = (await pg.client.query("SELECT * FROM analytics_order_facts")).rows;
      assertRollupProjection(facts,
        (await pg.client.query("SELECT * FROM analytics_sales_buckets")).rows,
        (await pg.client.query("SELECT * FROM analytics_customer_first_sale")).rows);
      await assertCustomerTimelines(pg.client);
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

  it("refreshes customer timelines after eligibility, date, identity and currency changes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixture = createAnalyticsFixture();
    try {
      const pg = await createNativePostgres({ label: "analytics_customers" });
      fixture.customer("timeline_registered", "Registered", "+8801799999900");
      for (const [id, createdAt, currencyCode, customerPhone, status] of [
        ["history_usd", "2026-07-01T12:00:00Z", "USD", "NO_PHONE", "cancelled"],
        ["history_a", "2026-08-10T12:00:00Z", "BDT", "NO_PHONE", "cancelled"],
        ["history_b", "2026-08-10T12:00:00Z", "BDT", "NO_PHONE", "cancelled"],
        ["history_last", "2026-08-20T12:00:00Z", "BDT", "NO_PHONE", "cancelled"],
        ["gap_before", "2026-07-01T12:00:00Z", "BDT", "+8801799999901", "delivered"],
        ["gap_after", "2026-09-01T12:00:00Z", "BDT", "+8801799999901", "delivered"],
        ["gap_middle", "2026-08-15T12:00:00Z", "BDT", "+8801799999901", "cancelled"],
        // Keep the summary reader selected even while the NO_PHONE history is dormant.
        ["filler_a", "2026-08-12T12:00:00Z", "BDT", "+8801799999902", "delivered"],
        ["filler_b", "2026-08-13T12:00:00Z", "BDT", "+8801799999902", "delivered"],
        ["filler_c", "2026-08-14T12:00:00Z", "BDT", "+8801799999902", "delivered"],
      ] as const) fixture.order({ id, createdAt, currencyCode, customerPhone, status, requiresShipping: false,
        lines: [{ id: `${id}_line`, productId: "p_timeline", quantity: 1, unitMinor: 101, fulfillmentType: "digital" }] });
      await copyFixture(pg.client, fixture);
      const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
      const sourceCtx = await createAnalyticsContext(fixture.db, "Asia/Dhaka");
      const parity = async () => {
        await assertCustomerTimelines(pg.client);
        for (const code of ["BDT", "USD"]) {
          const expected = await sourceOverviewPeriod({ ...sourceCtx, currency: { ...sourceCtx.currency, code } }, AUGUST);
          const actual = (await getAnalyticsOverviewForRequest({ ...ctx, currency: { ...ctx.currency, code } }, { ...AUGUST, comparison: "none" })).current;
          expect(actual).toEqual(expected);
        }
      };
      await parity();
      for (const statement of [
        "UPDATE orders SET status = 'delivered' WHERE customer_phone = 'NO_PHONE'",
        `UPDATE orders SET created_at = ${fixture.epoch("2026-09-05T12:00:00Z")} WHERE id = 'history_usd'`,
        `UPDATE orders SET created_at = ${fixture.epoch("2026-07-01T12:00:00Z")} WHERE id = 'history_usd'`,
        "UPDATE orders SET deleted_at = 123 WHERE id = 'history_usd'",
        "UPDATE orders SET deleted_at = NULL WHERE id = 'history_usd'",
        "UPDATE orders SET shop_currency = 'USD', currency_code = 'USD' WHERE id = 'history_a'",
        "UPDATE orders SET customer_id = 'timeline_registered' WHERE id = 'history_b'",
        "UPDATE orders SET customer_id = NULL WHERE id = 'history_b'",
        "UPDATE orders SET status = 'cancelled' WHERE customer_phone = 'NO_PHONE'",
        "UPDATE orders SET status = 'delivered' WHERE id = 'history_b'",
        "UPDATE orders SET status = 'delivered' WHERE id = 'history_usd'",
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
      }
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
      const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
      const actual = (await getAnalyticsOverviewForRequest(ctx, { ...AUGUST, comparison: "none" })).current;
      expect(actual).toEqual(expected);
      expect(actual.breakdowns.city.find((row) => row.key === "fx_positive")?.grossSales).toBe(6);
      expect(actual.breakdowns.city.find((row) => row.key === "fx_negative")?.grossSales).toBe(-6);
      expect((await pg.client.query("SELECT refunded FROM analytics_order_facts WHERE order_id = 'fx_positive'")).rows[0].refunded).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("truncates partial-return minor units after PostgreSQL quantity aggregation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pg = await createNativePostgres({ label: "analytics_partial_return" });
      const expected = await seed(pg.client, (fixture) => {
        fixture.order({ id: "partial", createdAt: "2026-08-20T12:00:00Z", status: "delivered", cityName: "partial",
          lines: [{ id: "partial_line", productId: "p_partial", quantity: 3, unitMinor: 101, discountMinor: 11, taxMinor: 31 }] });
        fixture.returnCase({ id: "partial_return", orderId: "partial", status: "approved", lines: [{ itemId: "partial_line", requested: 3, approved: 2 }] });
      });
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 3 WHERE id = 'partial_line'");
      await pg.client.query("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor - 3 WHERE id = 'partial_line'");
      const ctx = await createAnalyticsContext(pg.db, "Asia/Dhaka");
      const actual = (await getAnalyticsOverviewForRequest(ctx, { ...AUGUST, comparison: "none" })).current;
      expect(actual).toEqual(expected);
      expect(actual.breakdowns.city.find((row) => row.key === "partial")).toMatchObject({ returns: 194, taxes: 11, totalSales: 109 });
    } finally {
      log.mockRestore();
    }
  });
});
