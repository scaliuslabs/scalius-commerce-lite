import { afterEach, beforeEach, expect, it } from "vitest";
import { createAnalyticsFixture, type AnalyticsFixture } from "../../../../packages/core/src/modules/analytics/reports/reports.fixture";
import { assertRollupProjection } from "../../../../packages/core/src/modules/analytics/reports/overview-rollup.assertions";
import { maintainDerivedProjections } from "./derived-projections";

let f: AnalyticsFixture;
beforeEach(() => {
  f = createAnalyticsFixture();
  for (const [id, day] of [["drift_a", "10"], ["drift_b", "11"], ["drift_c", "12"]] as const) {
    f.order({ id, createdAt: `2026-08-${day}T12:00:00Z`, status: "delivered",
      lines: [{ id: `${id}_line`, productId: "p_drift", quantity: 2, unitMinor: 150 }] });
  }
  f.sqlite.exec(`INSERT INTO conversations (id, subject_type, order_id, status, last_message_at) VALUES ('cnv_drift_001', 'order', 'drift_a', 'open', 1)`);
});
afterEach(() => f.close());

const NOW = new Date("2026-09-01T00:00:00Z");
const report = (rebuild = false, afterOrderId: string | null = null) => maintainDerivedProjections(f.db, { now: NOW, rebuild, afterOrderId });

it("seals finished days and finds nothing to repair in step projections", async () => {
  expect(await report()).toEqual({
    sealedDays: 22,
    analytics: { drift: 0, repaired: false },
    recommendations: { drift: 0, repaired: false },
    inbox: { drift: 0, repaired: false },
  });
});

it("repairs drifted facts, sealed buckets, recommendation pairs and inbox counters", async () => {
  await report();
  const clock = () => Number(f.sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'recommendation-signals'").get()?.seq ?? 0);
  const before = clock();
  f.sqlite.exec(`
    UPDATE analytics_order_facts SET line_gross = line_gross + 7 WHERE order_id = 'drift_a';
    UPDATE analytics_sales_buckets SET gross = gross + 5 WHERE dimension_kind = 'total' AND grain_seconds = 86400;
    DELETE FROM recommendation_order_products WHERE order_id = 'drift_b';
    UPDATE conversation_inbox_counts SET open = open + 3 WHERE scope = '*';
  `);
  const repaired = await report();
  expect(repaired.analytics).toMatchObject({ repaired: true });
  expect(repaired.analytics.drift).toBeGreaterThan(0);
  expect(repaired.recommendations).toEqual({ drift: 1, repaired: true });
  expect(repaired.inbox).toEqual({ drift: 2, repaired: true });
  expect(clock()).toBeGreaterThan(before);
  // The drifted facts are rewritten at once; their days reseal on the next pass.
  expect(await report()).toMatchObject({ sealedDays: 22, analytics: { drift: 0 }, recommendations: { drift: 0 }, inbox: { drift: 0 } });
  await assertRollupProjection(f.db);
});

it("rebuilds in order-id chunks and unseals every day for the seal sweep", async () => {
  await report();
  f.sqlite.exec("UPDATE analytics_order_facts SET refund_sum = 9; DELETE FROM recommendation_order_products");
  const result = await report(true);
  expect(result).toMatchObject({ done: true, nextAfterOrderId: null, recommendations: { repaired: true } });
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_sealed_days").get()!.n).toBe(0);
  expect((await report()).sealedDays).toBe(22);
  await assertRollupProjection(f.db);
});
