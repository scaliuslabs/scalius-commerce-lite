// The private analytics projection (migration 0146). Pure SQL text: no core
// imports, bindings or database access; the migration, the readers and the
// rebuild share every expression here.
//
// - `analytics_order_facts`: one row per order with the order's own state and
//   running sums of its lines. A write moves only the columns its changed rows
//   feed (O(changed rows)); nothing re-reads a whole order except a change of
//   its FX rate or tax mode, which reconverts every line.
// - Measures are derived from those columns on read (`analyticsFactMeasureSql`).
// - `analytics_sales_buckets` (UTC days by dimension, 15-minute totals) count
//   only for days in `analytics_sealed_days`. Maintenance seals finished days
//   from their facts; a later write to a fact of a sealed day unseals it, and
//   readers take an unsealed day from its facts. No request writes a bucket,
//   so concurrent checkouts share no projection row.
// - Identity is the customer record, else the order itself: no phone number
//   is copied into the projection, and phoneless guests never merge.
import { currencyExponent, EXCLUDED_CURRENCY_CODES, SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency-policy";
import {
  COUNTED_RETURN_STATUSES, NON_SALES_STATUSES, REVERSED_STATUSES, lineKeptTaxSql, lineReturnsSql,
} from "./analytics-sales-sql";
import { symmetricDifference } from "./derived-projections";

export const ANALYTICS_MEASURES = ["order_count", "placed", "cancelled", "gross", "disc", "returns", "shipping", "taxes", "net_units", "cod", "rts", "cod_delivered", "refunded"] as const;
export const ANALYTICS_BUCKET_KEYS = ["grain_seconds", "dimension_kind", "bucket_start", "shop_currency", "key1", "key2"] as const;
const DIMENSIONS = ["created_at", "shop_currency", "channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id"] as const;
const ORDER_COLUMNS = ["order_id", "created_at", "shop_currency", "identity", "channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id", "order_count", "placed", "cancelled", "reversed", "delivered", "incl", "fx_rate", "fx_shift", "order_shipping", "order_discount", "order_tax"] as const;
const LINE_SUMS = ["line_gross", "line_disc", "line_returns", "line_kept_tax", "line_units", "line_rev_returns", "line_rev_kept_tax", "line_disc_all", "line_tax_all"] as const;
export const ANALYTICS_FACT_COLUMNS = [...ORDER_COLUMNS, ...LINE_SUMS, "refund_sum", "cod_collected"] as const;
/** The columns without a default: an upsert that only moves sums still names them. */
const REQUIRED = ["order_id", "created_at", "shop_currency", "identity", "channel", "payment_method", "requires_shipping"] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const COUNTED = quoted(COUNTED_RETURN_STATUSES);

/** An SQL string literal (ids read back from the database). */
export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The decimal-place shift from the order's currency to the shop's, the
 * `fxMultiplierText` exponent (0 for unknown places), or null when the order
 * was sold in the shop currency. Shop places follow `getDecimalPlaces`.
 */
function orderFxShift(o: string): string {
  const codes = [...SUPPORTED_CURRENCY_CODES, ...EXCLUDED_CURRENCY_CODES];
  const shopPlaces = `(case ${[0, 3, 4].map((places) => `when upper(trim(${o}.shop_currency)) in (${quoted(codes.filter((code) => currencyExponent(code) === places))}) then ${places}`).join(" ")} else 2 end)`;
  return `(case when ${o}.currency_code = ${o}.shop_currency then null
    when ${o}.currency_decimal_places in (0, 1, 2, 3) then ${shopPlaces} - ${o}.currency_decimal_places else 0 end)`;
}

/** The shop-currency multiplier of a row with fx_rate and fx_shift: the live reports' double. */
function fxm(ref: string): string {
  const factor = (shift: number) => shift >= 0 ? `${10 ** shift}.0` : `${1 / 10 ** -shift}`;
  return `(cast(${ref}.fx_rate as double precision) * (case ${ref}.fx_shift ${[4, 3, 2, 1, 0, -1, -2, -3].map((shift) => `when ${shift} then ${factor(shift)}`).join(" ")} end))`;
}

/** `expr` (order-currency minor units) in shop-currency minor units, for a row with fx_rate and fx_shift. */
function shop(expr: string, ref: string): string {
  return `(case when ${ref}.fx_shift is null then (${expr}) else cast(round((${expr}) * ${fxm(ref)}, 0) as bigint) end)`;
}

/** The order-level fact columns of the orders row `o`; amounts converted once. */
function orderState(o: string, from = ""): string {
  const live = `${o}.deleted_at is null`;
  const flag = (condition: string) => `(case when ${condition} then 1 else 0 end)`;
  const inner = [
    `${o}.id as order_id`, `${o}.created_at as created_at`, `${o}.shop_currency as shop_currency`,
    `(case when ${o}.customer_id is not null then 'c:' || ${o}.customer_id else 'o:' || ${o}.id end) as identity`,
    ...["channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id"].map((c) => `${o}.${c} as ${c}`),
    `${flag(`${live} and ${o}.status not in (${quoted(NON_SALES_STATUSES)})`)} as order_count`,
    `${flag(`${live} and ${o}.status <> 'incomplete'`)} as placed`,
    `${flag(`${live} and ${o}.status = 'cancelled'`)} as cancelled`,
    `${flag(`${o}.status in (${quoted(REVERSED_STATUSES)})`)} as reversed`,
    `${flag(`${o}.status in ('delivered', 'completed')`)} as delivered`,
    `${flag(`${o}.prices_include_tax = 1`)} as incl`,
    `${o}.fx_rate as fx_rate`, `${orderFxShift(o)} as fx_shift`,
    `${o}.shipping_amount_minor as order_shipping`, `${o}.discount_amount_minor as order_discount`, `${o}.tax_amount_minor as order_tax`,
  ];
  const outer = ORDER_COLUMNS.map((c) => c.startsWith("order_") && c !== "order_id" && c !== "order_count" ? `${shop(`s.${c}`, "s")} as ${c}` : `s.${c}`);
  return `select ${outer.join(", ")} from (select ${inner.join(", ")}${from}) as s`;
}

/** Accepted return units of an order line: approved units of its own order's counted return cases. */
function acceptedUnits(orderId: string, itemId: string): string {
  return `(select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = ${orderId} and rl.order_item_id = ${itemId} and rr.status in (${COUNTED}))`;
}

const LINE_FIELDS = ["quantity", "line_subtotal_minor", "discount_amount_minor", "tax_amount_minor", "fulfillment_type"] as const;
const lineFields = (ref: string) => [`${ref}.order_id as order_id`, ...LINE_FIELDS.map((c) => `${ref}.${c} as ${c}`)].join(", ");

/**
 * Per-order sums of `rows` (order_id, line fields, fx_rate, fx_shift, incl, raw accepted
 * units, sign). Each line is converted per line, then summed: the projection's
 * rounding equals the live reports' (`salesLinesCtesText`).
 */
function lineSumCtes(rows: string): string {
  const convert = (expr: string) => shop(expr, "lr");
  return `lr as materialized (${rows}),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        ${convert("lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)")} as g,
        ${convert("lr.discount_amount_minor")} as d, ${convert("lr.tax_amount_minor")} as t
      from lr)`;
}

const merchandise = (expr: string) => `(case when lb.gc = 0 then ${expr} else 0 end)`;
const sumOf = (expr: string, name: string) => `cast(sum(lb.sign * ${expr}) as bigint) as ${name}`;
const LINE_SUM_SELECT = `select lb.order_id, ${[
  sumOf(merchandise("lb.g"), "line_gross"),
  sumOf(merchandise("lb.d"), "line_disc"),
  sumOf(merchandise(lineReturnsSql("lb.g", "lb.d", "lb.q", "lb.rq")), "line_returns"),
  sumOf(merchandise(lineKeptTaxSql("lb.t", "lb.q", "lb.rq")), "line_kept_tax"),
  sumOf(merchandise("(lb.q - lb.rq)"), "line_units"),
  // A reversed order returns every unit: the formulas above with returned = quantity.
  sumOf(merchandise("(case when lb.q = 0 then 0 else lb.g - lb.d end)"), "line_rev_returns"),
  sumOf(merchandise("(case when lb.q = 0 then lb.t else 0 end)"), "line_rev_kept_tax"),
  sumOf("lb.d", "line_disc_all"),
  sumOf("lb.t", "line_tax_all"),
].join(", ")}
  from lb group by lb.order_id`;

function lineSums(rows: string): string {
  return `(with ${lineSumCtes(rows)} ${LINE_SUM_SELECT})`;
}

/** Moves (or, with `reset`, sets) the line sums of the facts `rows` touch. */
function applyLineSums(rows: string, reset?: string): string {
  const value = (c: string) => reset ? `coalesce(s.${c}, 0)` : `f.${c} + s.${c}`;
  return `insert into analytics_order_facts (${[...REQUIRED, ...LINE_SUMS].join(", ")})
    select ${[...REQUIRED.map((c) => `f.${c}`), ...LINE_SUMS.map(value)].join(", ")}
    from analytics_order_facts f ${reset ? "left join" : "join"} ${lineSums(rows)} as s on s.order_id = f.order_id
    where ${reset ? `f.order_id = ${reset}` : "1 = 1"}
    on conflict (order_id) do update set ${LINE_SUMS.map((c) => `${c} = excluded.${c}`).join(", ")}`;
}

/** The 13 report measures of a fact row (`f`: alias, NEW or OLD). */
export function analyticsFactMeasureSql(f: string): Record<(typeof ANALYTICS_MEASURES)[number], string> {
  const sale = `${f}.order_count = 1`;
  const kept = `${sale} and ${f}.reversed = 0`;
  const cod = `${sale} and ${f}.payment_method = 'cod'`;
  return {
    order_count: `${f}.order_count`,
    placed: `${f}.placed`,
    cancelled: `${f}.cancelled`,
    gross: `(case when ${sale} then ${f}.line_gross else 0 end)`,
    disc: `(case when ${sale} then ${f}.line_disc else 0 end)`,
    // Returned goods at what went back: a return refunded only in part (a
    // restocking fee kept) counts the refund, not the item value; a return
    // nothing was refunded for yet (cash on delivery never paid) counts the items.
    returns: `(case when not (${sale}) then 0 when ${f}.reversed = 1 then ${f}.line_rev_returns
      when ${f}.refund_sum > 0 and ${shop(`${f}.refund_sum`, f)} < ${f}.line_returns then ${shop(`${f}.refund_sum`, f)}
      else ${f}.line_returns end)`,
    // Charged shipping less its discount (order discount − line discounts) and included shipping tax.
    shipping: `(case when ${kept} then ${f}.order_shipping - (${f}.order_discount - ${f}.line_disc_all)
      - (case when ${f}.incl = 1 then ${f}.order_tax - ${f}.line_tax_all else 0 end) else 0 end)`,
    taxes: `(case when not (${sale}) then 0 when ${f}.reversed = 1 then ${f}.line_rev_kept_tax
      else ${f}.line_kept_tax + ${f}.order_tax - ${f}.line_tax_all end)`,
    net_units: `(case when ${kept} then ${f}.line_units else 0 end)`,
    cod: `(case when ${cod} then 1 else 0 end)`,
    rts: `(case when ${cod} and ${f}.reversed = 1 and ${f}.cod_collected = 0 then 1 else 0 end)`,
    cod_delivered: `(case when ${cod} and (${f}.delivered = 1 or ${f}.cod_collected > 0) then 1 else 0 end)`,
    refunded: `(case when ${sale} then ${shop(`${f}.refund_sum`, f)} else 0 end)`,
  };
}

/** The measure expressions of `f` in ANALYTICS_MEASURES order, for a positional union with bucket columns. */
export function analyticsFactMeasures(f: string): string {
  const measures = analyticsFactMeasureSql(f);
  return ANALYTICS_MEASURES.map((name) => `${measures[name]} as ${name}`).join(", ");
}

/** Bucket-shaped rows of facts: dimension columns and signed measures. */
function factContributions(f: string, sign: 1 | -1, tail: string): string {
  const measures = analyticsFactMeasureSql(f);
  return `select ${DIMENSIONS.map((c) => `${f}.${c} as ${c}`).join(", ")}, ${ANALYTICS_MEASURES.map((c) => `${sign === 1 ? "" : "-1 * "}${measures[c]} as ${c}`).join(", ")} ${tail}`;
}

/** Floor to a UTC bucket, including fractional seconds before the Unix epoch. */
function bucketStart(column: string, grain: number): string {
  const truncated = `cast(${column} / ${grain} as bigint)`;
  return `((${truncated} - case when ${column} < 0 and ${column} <> ${truncated} * ${grain} then 1 else 0 end) * ${grain})`;
}

/** Raw dimensions are typed by separate columns, so actual IDs cannot collide with fallback keys. */
function bucketContributions(source: string): string {
  const salesMeasures = new Set<string>(["order_count", "gross", "disc", "returns", "shipping", "taxes", "net_units"]);
  const measures = (total: boolean) => ANALYTICS_MEASURES
    .map((c) => total || salesMeasures.has(c) ? `f.${c}` : `0 as ${c}`).join(", ");
  const dimensions = [
    ["total", "''", "''"], ["channel", "f.channel", "coalesce(f.channel_source, '')"],
    ["payment", "f.payment_method", "''"], ["city", "coalesce(f.city_name, '')", "''"],
    ["delivery", "case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end", "coalesce(f.shipping_method_id, '')"],
    ["location", "case when f.fulfillment_location_id is null then 'default' else 'id' end", "coalesce(f.fulfillment_location_id, '')"],
  ];
  const parts = dimensions.map(([kind, k1, k2]) => `select 86400 as grain_seconds, '${kind}' as dimension_kind,
    ${bucketStart("f.created_at", 86400)} as bucket_start,
    f.shop_currency, ${k1} as key1, ${k2} as key2, ${measures(kind === "total")}
    from d f where ${kind === "total" ? "f.placed <> 0" : "f.order_count <> 0"}`);
  parts.push(`select 900 as grain_seconds, 'total' as dimension_kind,
    ${bucketStart("f.created_at", 900)} as bucket_start,
    f.shop_currency, '' as key1, '' as key2, ${measures(true)} from d f where f.placed <> 0`);
  // The D1 compound-select budget is five terms, including inside trigger statements.
  return `with d as materialized (${source})
    select * from (${parts.slice(0, 4).join(" union all ")}) as first_dimensions
    union all select * from (${parts.slice(4).join(" union all ")}) as last_dimensions`;
}

/** The bucket rows of `source` (fact-shaped rows with measures). */
function bucketRows(source: string): string {
  const keys = ANALYTICS_BUCKET_KEYS.join(", ");
  return `select ${keys}, ${ANALYTICS_MEASURES.map((c) => `sum(contributions.${c}) as ${c}`).join(", ")}
    from (${bucketContributions(source)}) as contributions group by ${keys}`;
}

/** The facts of the UTC days [from, through) as bucket-shaped rows. */
function dayFacts(from: number, through: number): string {
  return factContributions("f", 1, `from analytics_order_facts f where f.created_at >= ${from} and f.created_at < ${through}`);
}

/** Contiguous runs of UTC day starts. */
function dayRuns(days: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const day of [...new Set(days)].sort((left, right) => left - right)) {
    if (!Number.isSafeInteger(day) || day % 86400 !== 0) throw new Error("A sealed day must be a UTC day start.");
    const last = runs.at(-1);
    if (last && last[1] === day) last[1] = day + 86400;
    else runs.push([day, day + 86400]);
  }
  return runs;
}

/**
 * Seals UTC days: rebuilds their buckets from their facts and marks them, in
 * one batch. A day unsealed again before the batch commits stays exact: its
 * facts write either precedes the read here or removes the mark after it.
 */
export function analyticsSealStatements(days: readonly number[]): string[] {
  return dayRuns(days).flatMap(([from, through]) => [
    `delete from analytics_sales_buckets where bucket_start >= ${from} and bucket_start < ${through}`,
    `insert into analytics_sales_buckets (${[...ANALYTICS_BUCKET_KEYS, ...ANALYTICS_MEASURES].join(", ")}) ${bucketRows(dayFacts(from, through))}`,
    `insert into analytics_sealed_days (day) values ${Array.from({ length: (through - from) / 86400 }, (_, i) => `(${from + i * 86400})`).join(", ")} on conflict (day) do nothing`,
  ]);
}

/** Unsealed UTC days from the first fact's day to `through`, oldest first. */
export function analyticsUnsealedDaysSql(through: number, limit: number): string {
  return `with recursive span (day) as (
      select min(${bucketStart("f.created_at", 86400)}) from analytics_order_facts f
      union all select day + 86400 from span where day + 86400 < ${through})
    select day from span where day < ${through}
      and not exists (select 1 from analytics_sealed_days s where s.day = span.day)
    order by day limit ${limit}`;
}

/** Sealed days of [from, through) whose bucket rows differ from their facts (both directions). */
export function analyticsBucketDriftSql(from: number, through: number): string {
  const columns = [...ANALYTICS_BUCKET_KEYS, ...ANALYTICS_MEASURES].join(", ");
  const sealedDay = (column: string) => `exists (select 1 from analytics_sealed_days s where s.day = ${bucketStart(column, 86400)})`;
  const expected = `select * from (${bucketRows(dayFacts(from, through))}) as e where ${sealedDay("e.bucket_start")}`;
  const stored = `select ${columns} from analytics_sales_buckets b
    where b.bucket_start >= ${from} and b.bucket_start < ${through} and ${sealedDay("b.bucket_start")}`;
  return symmetricDifference(expected, stored);
}

/**
 * Every fact column recomputed from the sources, for the orders `orderScope`
 * selects (alias o, e.g. `o.id > 'x' order by o.id limit 500`).
 */
export function analyticsFactsSelect(orderScope: string): string {
  const rows = `select ${lineFields("oi")}, so.fx_rate as fx_rate, so.fx_shift as fx_shift, so.incl as incl,
    ${acceptedUnits("oi.order_id", "oi.id")} as raw, 1 as sign
    from so cross join order_items oi where oi.order_id = so.order_id`;
  const refunds = `(select cast(coalesce(sum(p.amount_minor), 0) as bigint) from order_payments p
    where p.order_id = so.order_id and p.payment_type = 'refund' and p.status = 'refunded')`;
  const collected = `(select count(*) from cod_tracking ct where ct.order_id = so.order_id and ct.cod_status = 'collected')`;
  return `with so as materialized (${orderState("o", ` from orders o where ${orderScope}`)}),
    ${lineSumCtes(rows)}, ls as (${LINE_SUM_SELECT})
    select ${[...ORDER_COLUMNS.map((c) => `so.${c}`), ...LINE_SUMS.map((c) => `coalesce(ls.${c}, 0) as ${c}`),
      `${refunds} as refund_sum`, `${collected} as cod_collected`].join(", ")}
    from so left join ls on ls.order_id = so.order_id`;
}

/** Every order's facts, into an empty projection (the migration, bulk-loaded fixtures). */
export function analyticsFactsBackfillStatement(): string {
  return `insert into analytics_order_facts (${ANALYTICS_FACT_COLUMNS.join(", ")}) ${analyticsFactsSelect("1 = 1")}`;
}

/** Upserts recomputed facts for `orderScope`, writing only rows that differ. */
export function analyticsFactsRepairStatement(orderScope: string): string {
  const updates = ANALYTICS_FACT_COLUMNS.filter((c) => c !== "order_id");
  return `insert into analytics_order_facts (${ANALYTICS_FACT_COLUMNS.join(", ")})
    select * from (${analyticsFactsSelect(orderScope)}) as recomputed where 1 = 1
    on conflict (order_id) do update set ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}
    where ${updates.map((c) => `analytics_order_facts.${c} is not excluded.${c}`).join(" or ")}`;
}

/** Fact rows of `orderScope` that differ from their recomputation (both directions). */
export function analyticsFactsDriftSql(orderScope: string): string {
  const columns = ANALYTICS_FACT_COLUMNS.join(", ");
  const expected = `select ${columns} from (${analyticsFactsSelect(orderScope)}) as e`;
  const stored = `select ${columns} from analytics_order_facts where order_id in (select o.id from orders o where ${orderScope})`;
  return symmetricDifference(expected, stored);
}

export interface AnalyticsRollupTrigger { name: string; table: string; sqlite: string }

function trigger(name: string, event: string, table: string, body: string, guard?: string): AnalyticsRollupTrigger {
  return { name, table, sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}${guard ? `\nWHEN ${guard}` : ""}\nBEGIN\n  ${body};\nEND` };
}

const changed = (columns: readonly string[]) => columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
const counted = (returnId: string) => `EXISTS (SELECT 1 FROM order_returns r WHERE r.id = ${returnId} AND r.status IN (${COUNTED}))`;
const SIGNS = "(select 1 as sign union all select -1 as sign) as x";

/** The maintenance triggers of the projection (migration 0146). */
export function generateAnalyticsRollupTriggers(): AnalyticsRollupTrigger[] {
  const orderColumns = ["created_at", "deleted_at", "status", "shop_currency", "currency_code", "currency_decimal_places", "fx_rate", "prices_include_tax", "shipping_amount_minor", "discount_amount_minor", "tax_amount_minor", "customer_id", "channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id"];
  const fxColumns = ["shop_currency", "currency_code", "currency_decimal_places", "fx_rate", "prices_include_tax"];
  const upsertOrder = `insert into analytics_order_facts (${ORDER_COLUMNS.join(", ")})
    select * from (${orderState("NEW")}) as o where 1 = 1
    on conflict (order_id) do update set ${ORDER_COLUMNS.filter((c) => c !== "order_id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
  const reconvert = applyLineSums(`select ${lineFields("oi")}, x.fx_rate as fx_rate, x.fx_shift as fx_shift, x.incl as incl,
      ${acceptedUnits("oi.order_id", "oi.id")} as raw, 1 as sign
    from order_items oi cross join (select NEW.fx_rate as fx_rate, ${orderFxShift("NEW")} as fx_shift,
      (case when NEW.prices_include_tax = 1 then 1 else 0 end) as incl) as x
    where oi.order_id = NEW.id`, "NEW.id");
  const itemRow = (ref: "NEW" | "OLD") => `select ${lineFields(ref)}, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      ${acceptedUnits(`${ref}.order_id`, `${ref}.id`)} as raw, ${ref === "NEW" ? 1 : -1} as sign
    from analytics_order_facts c where c.order_id = ${ref}.order_id`;
  const itemColumns = ["id", "order_id", ...LINE_FIELDS];

  // A return line moves the accepted units of the order line it counts against:
  // each affected line once now (+1) and once as it was before the write (−1).
  const returnLineRows = (refs: ReadonlyArray<"NEW" | "OLD">) => {
    const matches = (ref: string) => `(oi.id = ${ref}.order_item_id and oi.order_id = ${ref}.order_id)`;
    const units = (ref: string) => `(case when ${matches(ref)} and ${counted(`${ref}.return_id`)} then ${ref}.approved_quantity else 0 end)`;
    const before = refs.map((ref) => `${ref === "NEW" ? "-" : "+"} ${units(ref)}`).join(" ");
    return `select ${lineFields("oi")}, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
        ${acceptedUnits("oi.order_id", "oi.id")} + (case when x.sign = 1 then 0 else ${before} end) as raw, x.sign as sign
      from order_items oi join analytics_order_facts c on c.order_id = oi.order_id cross join ${SIGNS}
      where ${refs.map(matches).join(" or ")}`;
  };
  const statusCounted = (ref: string) => `(case when ${ref}.status in (${COUNTED}) then 1 else 0 end)`;
  const returnRows = `select ${lineFields("oi")}, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      ${acceptedUnits("oi.order_id", "oi.id")} + (case when x.sign = 1 then 0
        else (${statusCounted("OLD")} - ${statusCounted("NEW")}) * rl.approved_quantity end) as raw, x.sign as sign
    from order_return_lines rl join order_items oi on oi.id = rl.order_item_id and oi.order_id = rl.order_id
    join analytics_order_facts c on c.order_id = oi.order_id cross join ${SIGNS}
    where rl.return_id = NEW.id`;

  const refund = (ref: string) => `${ref}.payment_type = 'refund' AND ${ref}.status = 'refunded'`;
  const collected = (ref: string) => `${ref}.cod_status = 'collected'`;
  /** A counter column moved by the rows a payment or COD write qualifies. */
  const counter = (column: string, amount: (ref: string) => string, qualifies: (ref: string) => string, refs: ReadonlyArray<"NEW" | "OLD">) => {
    const term = (ref: string) => `${ref === "NEW" ? "+" : "-"} (case when order_id = ${ref}.order_id and ${qualifies(ref)} then ${amount(ref)} else 0 end)`;
    return `UPDATE analytics_order_facts SET ${column} = ${column} ${refs.map(term).join(" ")} WHERE order_id IN (${refs.map((ref) => `${ref}.order_id`).join(", ")})`;
  };
  const refundAmount = (ref: string) => `coalesce(${ref}.amount_minor, 0)`;
  const one = () => "1";
  const paymentColumns = ["order_id", "payment_type", "status", "amount_minor"];
  const codColumns = ["order_id", "cod_status"];

  // A changed fact unseals its day (old and new): readers take it from facts until resealed.
  const day = (ref: string) => bucketStart(`${ref}.created_at`, 86400);
  const sealed = (ref: string) => `EXISTS (SELECT 1 FROM analytics_sealed_days s WHERE s.day = ${day(ref)})`;
  const unseal = (refs: ReadonlyArray<"NEW" | "OLD">) => `DELETE FROM analytics_sealed_days WHERE day IN (${refs.map(day).join(", ")})`;

  return [
    trigger("analytics_orders_insert", "INSERT", "orders", upsertOrder),
    trigger("analytics_orders_update", `UPDATE OF ${orderColumns.join(", ")}`, "orders", upsertOrder, changed(orderColumns)),
    trigger("analytics_orders_reconvert", `UPDATE OF ${fxColumns.join(", ")}`, "orders", reconvert, changed(fxColumns)),
    trigger("analytics_order_items_insert", "INSERT", "order_items", applyLineSums(itemRow("NEW"))),
    trigger("analytics_order_items_update", `UPDATE OF ${itemColumns.join(", ")}`, "order_items",
      applyLineSums(`${itemRow("OLD")} union all ${itemRow("NEW")}`), changed(itemColumns)),
    trigger("analytics_order_items_delete", "DELETE", "order_items", applyLineSums(itemRow("OLD"))),
    trigger("analytics_return_lines_insert", "INSERT", "order_return_lines", applyLineSums(returnLineRows(["NEW"])),
      `NEW.approved_quantity <> 0 AND ${counted("NEW.return_id")}`),
    trigger("analytics_return_lines_update", "UPDATE OF order_id, return_id, order_item_id, approved_quantity", "order_return_lines",
      applyLineSums(returnLineRows(["OLD", "NEW"])),
      `(${changed(["order_id", "return_id", "order_item_id", "approved_quantity"])}) AND (${counted("OLD.return_id")} OR ${counted("NEW.return_id")})`),
    trigger("analytics_return_lines_delete", "DELETE", "order_return_lines", applyLineSums(returnLineRows(["OLD"])),
      `OLD.approved_quantity <> 0 AND ${counted("OLD.return_id")}`),
    trigger("analytics_returns_status", "UPDATE OF status", "order_returns", applyLineSums(returnRows),
      `${statusCounted("OLD")} <> ${statusCounted("NEW")}`),
    trigger("analytics_payments_insert", "INSERT", "order_payments", counter("refund_sum", refundAmount, refund, ["NEW"]), refund("NEW")),
    trigger("analytics_payments_update", `UPDATE OF ${paymentColumns.join(", ")}`, "order_payments",
      counter("refund_sum", refundAmount, refund, ["OLD", "NEW"]), `(${changed(paymentColumns)}) AND (${refund("OLD")} OR ${refund("NEW")})`),
    trigger("analytics_payments_delete", "DELETE", "order_payments", counter("refund_sum", refundAmount, refund, ["OLD"]), refund("OLD")),
    trigger("analytics_cod_insert", "INSERT", "cod_tracking", counter("cod_collected", one, collected, ["NEW"]), collected("NEW")),
    trigger("analytics_cod_update", `UPDATE OF ${codColumns.join(", ")}`, "cod_tracking",
      counter("cod_collected", one, collected, ["OLD", "NEW"]), `(${changed(codColumns)}) AND (${collected("OLD")} OR ${collected("NEW")})`),
    trigger("analytics_cod_delete", "DELETE", "cod_tracking", counter("cod_collected", one, collected, ["OLD"]), collected("OLD")),
    trigger("analytics_facts_unseal_insert", "INSERT", "analytics_order_facts", unseal(["NEW"]), sealed("NEW")),
    trigger("analytics_facts_unseal_update", "UPDATE", "analytics_order_facts", unseal(["OLD", "NEW"]), `${sealed("OLD")} OR ${sealed("NEW")}`),
    trigger("analytics_facts_unseal_delete", "DELETE", "analytics_order_facts", unseal(["OLD"]), sealed("OLD")),
  ];
}
