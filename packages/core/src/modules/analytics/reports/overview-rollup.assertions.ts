// Test-only, deliberately independent of the production bucket generator.
import { expect } from "vitest";

type Row = Record<string, unknown>;
const measures = ["order_count", "placed", "cancelled", "gross", "disc", "returns", "shipping", "taxes", "net_units", "cod", "rts", "cod_delivered", "refunded"] as const;
const keys = ["grain_seconds", "dimension_kind", "bucket_start", "shop_currency", "key1", "key2"] as const;
const totalsOnly = new Set<string>(["placed", "cancelled", "cod", "rts", "cod_delivered", "refunded"]);
const bucketKey = (row: Row) => JSON.stringify(keys.map((key) => row[key]));
const nonzero = (row: Row) => measures.some((key) => Number(row[key]) !== 0);

/** Every bucket must equal its fact contributions, including old keys after moves. */
export function assertRollupProjection(facts: Row[], buckets: Row[], firstSales: Row[]) {
  const expected = new Map<string, Row>();
  const first = new Map<string, number>();
  for (const fact of facts) {
    if (fact.order_count === 1) {
      const identity = String(fact.identity);
      first.set(identity, Math.min(first.get(identity) ?? Infinity, Number(fact.created_at)));
    }
    const delivery = fact.requires_shipping === 0 ? "none" : fact.shipping_method_kind === "pickup" ? "pickup" : fact.shipping_method_id === null ? "unknown" : "method";
    const dimensions: Array<[number, string, string, string]> = [
      [86400, "total", "", ""], [900, "total", "", ""],
      [86400, "channel", String(fact.channel), String(fact.channel_source ?? "")],
      [86400, "payment", String(fact.payment_method), ""],
      [86400, "city", String(fact.city_name ?? ""), ""],
      [86400, "delivery", delivery, String(fact.shipping_method_id ?? "")],
      [86400, "location", fact.fulfillment_location_id === null ? "default" : "id", String(fact.fulfillment_location_id ?? "")],
    ];
    for (const [grain, kind, key1, key2] of dimensions) {
      if (kind === "total" ? fact.placed === 0 : fact.order_count === 0) continue;
      const row: Row = { grain_seconds: grain, dimension_kind: kind, bucket_start: Math.floor(Number(fact.created_at) / grain) * grain, shop_currency: fact.shop_currency, key1, key2 };
      const id = bucketKey(row);
      const previous = expected.get(id);
      for (const measure of measures) row[measure] = Number(previous?.[measure] ?? 0) + (kind !== "total" && totalsOnly.has(measure) ? 0 : Number(fact[measure]));
      expected.set(id, row);
    }
  }
  const sorted = (rows: Row[]) => rows.filter(nonzero).sort((a, b) => bucketKey(a).localeCompare(bucketKey(b)));
  expect(sorted(buckets)).toEqual(sorted([...expected.values()]));
  expect(firstSales.filter((row) => row.first_sale_at !== null).sort((a, b) => String(a.identity).localeCompare(String(b.identity))))
    .toEqual([...first].map(([identity, first_sale_at]) => ({ identity, first_sale_at })).sort((a, b) => a.identity.localeCompare(b.identity)));
}
