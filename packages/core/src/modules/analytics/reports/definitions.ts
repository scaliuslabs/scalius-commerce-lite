// What each catalogued report reads. Every sales figure goes through the
// shared CTEs in sales-sql.ts; this file only groups them. Reports that name
// customers are gated by the caller (the route), not here.
import { sql, type SQL } from "drizzle-orm";
import { collections, productVariants } from "@scalius/database/schema";
import { isNull, asc } from "drizzle-orm";
import {
  analyticsBuckets,
  analyticsDateKeyFromEpochDay,
  analyticsInstantRange,
  analyticsRangeDays,
  type AnalyticsGranularity,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import type { AnalyticsReportId } from "@scalius/shared/analytics-reports";
import { collectionMembershipForConfig } from "../../collections";
import {
  buildNeedsRestockCondition,
  effectiveLowStockThresholdSql,
  operationalSkuRowPredicate,
  variantOptionLabelSql,
} from "../../products";
import {
  bucketStartSql,
  isFirstSalesOrderSql,
  lineMeasuresSql,
  merchantDaySql,
  NON_SALES_STATUSES,
  orderIdentitySql,
  orderMeasuresSql,
  orderMetricsCtes,
  salesLinesCtes,
  salesOrdersCte,
  type SalesLineOptions,
} from "./sales-sql";
import { num, type AnalyticsContext } from "./context";
import { averageOrderValueMinor, percentOf } from "./overview";
import type { ReportCell, ReportImplementation, ReportParams, ReportRow, SqlReport } from "./engine";

const DAY_SECONDS = 86_400;
/** Collections a collection report reads (by position), and membership pairs it sends. */
export const COLLECTION_REPORT_MAX_COLLECTIONS = 200;
export const COLLECTION_REPORT_MAX_PAIRS = 5_000;
/** Abandoned checkouts are kept this many days (`DEFAULT_ABANDONED_CHECKOUT_RETENTION_DAYS`). */
const ABANDONED_RETENTION_DAYS = 30;
/** An abandoned checkout counts as recovered when its phone orders within this many days. */
export const ABANDONED_RECOVERY_WINDOW_DAYS = 7;

const NON_SALES = sql.raw(NON_SALES_STATUSES.map((status) => `'${status}'`).join(", "));

function requireRange(params: ReportParams): AnalyticsRange {
  if (!params.range) throw new RangeError("This report needs a date range.");
  return params.range;
}

function requireGranularity(params: ReportParams): AnalyticsGranularity {
  return params.granularity ?? "day";
}

/** The sales CTE chain for a range: `so`, `sl`/`sv`/`lv`, `lo`/`om`. */
function salesCtes(ctx: AnalyticsContext, range: AnalyticsRange, options: SalesLineOptions = {}): SQL {
  const scope = { ...analyticsInstantRange(range), currency: ctx.currency.code };
  return sql`${salesOrdersCte(scope)}, ${salesLinesCtes(options)}, ${orderMetricsCtes()}`;
}

/** `od`: sales orders with their delivery zone and stock location keys. */
const ORDER_DIMENSIONS_CTE = sql`od as (
  select om.*,
    case
      when om.requires_shipping = 0 then '__no_delivery'
      when om.shipping_method_kind = 'pickup' then '__pickup'
      when om.shipping_method_id is null then '__unknown'
      when dz.id is null then '__everywhere_else'
      else dz.id
    end as zone_key,
    coalesce(dz.name, '') as zone_label,
    coalesce(om.fulfillment_location_id, (
      select dl.id from inventory_locations dl where dl.is_default = 1
    ), '') as location_key
  from om
  left join shipping_methods sm on sm.id = om.shipping_method_id
  left join delivery_zones dz on dz.id = sm.zone_id
)`;

const AOV_SQL = sql.raw("case when count(*) > 0 then (sum(od.gross) - sum(od.disc)) * 1.0 / count(*) end as average_order_value");

function finishOrderRow(values: Record<string, ReportCell>): void {
  values.average_order_value = averageOrderValueMinor(num(values.gross_sales), num(values.discounts), num(values.orders));
}

function finishOrderTotals(totals: Record<string, ReportCell>): void {
  totals.average_order_value = averageOrderValueMinor(num(totals.gross_sales), num(totals.discounts), num(totals.orders));
}

/** An order-level breakdown: each order counted once, in the row its dimension names. */
function orderDimensionReport(spec: { id: string; columns: string; joins?: string; groupBy: string }): SqlReport {
  return {
    kind: "sql",
    async build(ctx, params) {
      return {
        ctes: sql`${salesCtes(ctx, requireRange(params))}, ${ORDER_DIMENSIONS_CTE}`,
        select: sql`select ${sql.raw(spec.id)} as id, ${sql.raw(spec.columns)}, ${orderMeasuresSql("od")}, ${AOV_SQL}
          from od ${sql.raw(spec.joins ?? "")}
          group by ${sql.raw(spec.groupBy)}`,
      };
    },
    finishRow: finishOrderRow,
    finishTotals: finishOrderTotals,
  };
}

/** A line-level breakdown over merchandise lines. */
function lineDimensionReport(spec: { id: string; columns: string; joins?: string; groupBy: string }): SqlReport {
  return {
    kind: "sql",
    async build(ctx, params) {
      return {
        ctes: salesCtes(ctx, requireRange(params)),
        select: sql`select ${sql.raw(spec.id)} as id, ${sql.raw(spec.columns)}, ${lineMeasuresSql("lv")}
          from lv ${sql.raw(spec.joins ?? "")}
          where lv.gc = 0
          group by ${sql.raw(spec.groupBy)}`,
      };
    },
  };
}

/** Rows read through a raw relation with named fields (portable row shapes on every provider). */
async function selectRows(ctx: AnalyticsContext, relation: SQL, fieldNames: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const fields = Object.fromEntries(fieldNames.map((name) => [name, sql`q.${sql.raw(name)}`])) as Record<string, SQL<unknown>>;
  return await ctx.db.select(fields).from(sql`(${relation}) as q`) as Array<Record<string, unknown>>;
}

function bucketRows<T extends Record<string, ReportCell>>(
  range: AnalyticsRange,
  granularity: AnalyticsGranularity,
  found: Map<string, T>,
  empty: () => T,
): ReportRow[] {
  return analyticsBuckets(range, granularity).map((bucket) => ({
    id: bucket.key,
    values: { period: bucket.key, ...(found.get(bucket.key) ?? empty()) },
  }));
}

function bucketKeyOf(value: unknown): string {
  return analyticsDateKeyFromEpochDay(num(value));
}

function dateOf(value: ReportCell | undefined): ReportCell {
  return value === null || value === undefined || value === "" ? null : analyticsDateKeyFromEpochDay(num(value));
}

// ─── Sales ──────────────────────────────────────────────────────────────────

const ORDER_MEASURE_FIELDS = [
  "orders",
  "gross_sales",
  "discounts",
  "returns",
  "net_sales",
  "shipping",
  "taxes",
  "total_sales",
  "net_items_sold",
] as const;

const salesOverTime: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const granularity = requireGranularity(params);
    const bucket = bucketStartSql(merchantDaySql("om.created_at"), granularity, range);
    const rows = await selectRows(ctx, sql`with ${salesCtes(ctx, range)}
      select ${bucket} as bucket, ${orderMeasuresSql("om")}
      from om group by ${bucket}`, ["bucket", ...ORDER_MEASURE_FIELDS]);
    const found = new Map(rows.map((row) => {
      const values: Record<string, ReportCell> = Object.fromEntries(ORDER_MEASURE_FIELDS.map((key) => [key, num(row[key])]));
      finishOrderRow(values);
      return [bucketKeyOf(row.bucket), values];
    }));
    const empty = () => {
      const values: Record<string, ReportCell> = Object.fromEntries(ORDER_MEASURE_FIELDS.map((key) => [key, 0]));
      values.average_order_value = 0;
      return values;
    };
    return { rows: bucketRows(range, granularity, found, empty) };
  },
  finishTotals: finishOrderTotals,
};

const PRODUCT_NAME = "coalesce(p.name, max(lv.product_name), '')";

const salesByProduct = lineDimensionReport({
  id: "lv.product_id",
  columns: `${PRODUCT_NAME} as product, lv.product_id as link_product_id`,
  joins: "left join products p on p.id = lv.product_id",
  groupBy: "lv.product_id, p.name",
});

const salesByVariant = lineDimensionReport({
  id: "coalesce(lv.variant_id, 'product:' || lv.product_id)",
  columns: `${PRODUCT_NAME} as product, coalesce(max(lv.variant_label), '') as variant,
    coalesce(pv.sku, '') as sku, lv.product_id as link_product_id`,
  joins: "left join products p on p.id = lv.product_id left join product_variants pv on pv.id = lv.variant_id",
  groupBy: "coalesce(lv.variant_id, 'product:' || lv.product_id), lv.product_id, p.name, pv.sku",
});

const salesByCategory = lineDimensionReport({
  id: "coalesce(p.category_id, '')",
  columns: "coalesce(c.name, '') as category",
  joins: "left join products p on p.id = lv.product_id left join categories c on c.id = p.category_id",
  groupBy: "coalesce(p.category_id, ''), coalesce(c.name, '')",
});

const salesByBrand = lineDimensionReport({
  id: "coalesce(p.brand_id, '')",
  columns: "coalesce(b.name, '') as brand",
  joins: "left join products p on p.id = lv.product_id left join brands b on b.id = p.brand_id",
  groupBy: "coalesce(p.brand_id, ''), coalesce(b.name, '')",
});

/**
 * Collections by their membership today (Shopify does the same): a manual
 * collection's products, a dynamic collection's categories. A product in two
 * collections counts in both, so the rows don't add up to the store total.
 */
const salesByCollection: SqlReport = {
  kind: "sql",
  async build(ctx, params) {
    const rows = await ctx.db
      .select({ id: collections.id, config: collections.config })
      .from(collections)
      .where(isNull(collections.deletedAt))
      .orderBy(asc(collections.sortOrder), asc(collections.id))
      .limit(COLLECTION_REPORT_MAX_COLLECTIONS + 1);
    const notes: string[] = [];
    if (rows.length > COLLECTION_REPORT_MAX_COLLECTIONS) notes.push("collections_capped");
    const manual: Array<{ c: string; p: string }> = [];
    const dynamic: Array<{ c: string; k: string }> = [];
    for (const row of rows.slice(0, COLLECTION_REPORT_MAX_COLLECTIONS)) {
      const membership = collectionMembershipForConfig(row.config);
      for (const productId of membership.productIds) manual.push({ c: row.id, p: productId });
      for (const categoryId of membership.categoryIds) dynamic.push({ c: row.id, k: categoryId });
    }
    if (manual.length + dynamic.length > COLLECTION_REPORT_MAX_PAIRS) {
      notes.push("collections_capped");
      manual.splice(COLLECTION_REPORT_MAX_PAIRS);
      dynamic.splice(Math.max(0, COLLECTION_REPORT_MAX_PAIRS - manual.length));
    }
    return {
      notes: [...new Set(notes)],
      ctes: sql`${salesCtes(ctx, requireRange(params))},
        mp as (
          select cast(json_extract(value, '$.c') as text) as collection_id,
            cast(json_extract(value, '$.p') as text) as product_id
          from json_each(${JSON.stringify(manual)})
        ),
        mc as (
          select cast(json_extract(value, '$.c') as text) as collection_id,
            cast(json_extract(value, '$.k') as text) as category_id
          from json_each(${JSON.stringify(dynamic)})
        ),
        cl as (
          select mp.collection_id, lv.* from lv join mp on mp.product_id = lv.product_id where lv.gc = 0
          union all
          select mc.collection_id, lv.* from lv
          join products cp on cp.id = lv.product_id
          join mc on mc.category_id = cp.category_id
          where lv.gc = 0
        )`,
      select: sql`select cl.collection_id as id, coalesce(col.name, '') as collection, ${lineMeasuresSql("cl")}
        from cl left join collections col on col.id = cl.collection_id
        group by cl.collection_id, coalesce(col.name, '')`,
    };
  },
};

/**
 * Discounts by promotion and code: the orders that used each, the discount
 * they got and those orders' sales. Discounts with no promotion behind them
 * (a manual amount on a dashboard order, an app's discount) form one row.
 */
const salesByDiscount: SqlReport = {
  kind: "sql",
  async build(ctx, params) {
    return {
      ctes: sql`${salesCtes(ctx, requireRange(params))},
        da as (
          select a.order_id, a.promotion_id, coalesce(a.promotion_code, '') as code,
            max(a.promotion_name) as name, max(a.method) as method, sum(a.discount_amount_minor) as amount
          from order_discount_allocations a
          join so on so.id = a.order_id
          group by a.order_id, a.promotion_id, coalesce(a.promotion_code, '')
        ),
        md as (
          select om.id as order_id, om.discount_amount_minor - coalesce((
            select sum(a2.discount_amount_minor) from order_discount_allocations a2 where a2.order_id = om.id
          ), 0) as amount
          from om
        )`,
      select: sql`select da.promotion_id || '|' || da.code as id, max(da.name) as discount, da.code as code,
          max(da.method) as method, count(*) as orders, sum(da.amount) as discount_amount,
          sum(om.gross) as gross_sales, sum(om.gross - om.disc - om.returns) as net_sales,
          sum(om.gross - om.disc - om.returns + om.shipping + om.taxes) as total_sales
        from da join om on om.id = da.order_id
        group by da.promotion_id, da.code
        union all
        select '__manual', '', '', 'manual', count(*), coalesce(sum(md.amount), 0),
          coalesce(sum(om.gross), 0), coalesce(sum(om.gross - om.disc - om.returns), 0),
          coalesce(sum(om.gross - om.disc - om.returns + om.shipping + om.taxes), 0)
        from md join om on om.id = md.order_id
        where md.amount > 0
        having count(*) > 0`,
    };
  },
};

const salesByChannel = orderDimensionReport({
  id: "od.channel || '|' || coalesce(od.channel_source, '')",
  columns: "od.channel as channel, coalesce(od.channel_source, '') as source",
  groupBy: "od.channel, coalesce(od.channel_source, '')",
});

const salesByPaymentMethod = orderDimensionReport({
  id: "od.payment_method",
  columns: "od.payment_method as payment_method",
  groupBy: "od.payment_method",
});

const salesByCity = orderDimensionReport({
  id: "coalesce(od.city_name, '')",
  columns: "coalesce(od.city_name, '') as city",
  groupBy: "coalesce(od.city_name, '')",
});

const salesByDeliveryZone = orderDimensionReport({
  // One row per group: a key (`__no_delivery`) can have several zone names, so the id carries both.
  id: "od.zone_key || '|' || od.zone_label",
  columns: "case when od.zone_label = '' then od.zone_key else od.zone_label end as delivery_zone",
  groupBy: "od.zone_key, od.zone_label",
});

const salesByLocation = orderDimensionReport({
  id: "od.location_key",
  columns: "coalesce(il.name, '') as location",
  joins: "left join inventory_locations il on il.id = od.location_key",
  groupBy: "od.location_key, coalesce(il.name, '')",
});

// ─── Customers ──────────────────────────────────────────────────────────────

/** Customers by what they bought in the range. Names and phones: customers.view only (route). */
const customersTop: SqlReport = {
  kind: "sql",
  async build(ctx, params) {
    return {
      ctes: sql`${salesCtes(ctx, requireRange(params))},
        ci as (select ${orderIdentitySql("om")} as identity, om.* from om),
        cg as (
          select ci.identity, max(ci.customer_id) as customer_id, max(ci.customer_phone) as order_phone,
            max(ci.customer_name) as order_name, count(*) as orders,
            sum(ci.gross - ci.disc - ci.returns + ci.shipping + ci.taxes) as total_sales,
            sum(ci.gross - ci.disc - ci.returns) as net_sales,
            sum(ci.gross) as gross_sales, sum(ci.disc) as discounts,
            min(ci.created_at) as first_in_range, max(ci.created_at) as last_in_range
          from ci group by ci.identity
        )`,
      // First order ever: an index probe per customer (orders_customer_activity_idx / orders_customer_phone_idx).
      select: sql`select cg.identity as id,
          coalesce(cust.name, cg.order_name, '') as customer,
          coalesce(cust.phone, cg.order_phone, '') as phone,
          cg.orders as orders, cg.total_sales as total_sales, cg.net_sales as net_sales,
          case when cg.orders > 0 then (cg.gross_sales - cg.discounts) * 1.0 / cg.orders end as average_order_value,
          cg.gross_sales as gross_sales, cg.discounts as discounts,
          ${merchantDaySql(`coalesce(case
            when cg.customer_id is not null then (
              select min(p.created_at) from orders p
              where p.customer_id = cg.customer_id and p.deleted_at is null
                and p.status not in ('incomplete', 'cancelled'))
            else (
              select min(p.created_at) from orders p
              where p.customer_phone = cg.order_phone and p.customer_id is null and p.deleted_at is null
                and p.status not in ('incomplete', 'cancelled'))
          end, cg.first_in_range)`)} as first_order,
          ${merchantDaySql("cg.last_in_range")} as last_order
        from cg left join customers cust on cust.id = cg.customer_id`,
    };
  },
  finishRow(values) {
    values.average_order_value = averageOrderValueMinor(num(values.gross_sales), num(values.discounts), num(values.orders));
    values.first_order = dateOf(values.first_order);
    values.last_order = dateOf(values.last_order);
  },
};

/**
 * Per bucket: distinct customers who ordered, how many of them placed their
 * first-ever order in it (new), the rest (returning), and new customers' sales.
 */
const customersOverTime: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const granularity = requireGranularity(params);
    const bucket = bucketStartSql(merchantDaySql("cf.created_at"), granularity, range);
    const fields = ["bucket", "customers", "new_customers", "orders", "new_customer_sales"] as const;
    const rows = await selectRows(ctx, sql`with ${salesCtes(ctx, range)},
      cf as (
        select om.*, ${orderIdentitySql("om")} as identity, ${isFirstSalesOrderSql("om")} as is_first
        from om
      )
      select ${bucket} as bucket, count(distinct cf.identity) as customers,
        coalesce(sum(cf.is_first), 0) as new_customers, count(*) as orders,
        coalesce(sum(case when cf.is_first = 1
          then cf.gross - cf.disc - cf.returns + cf.shipping + cf.taxes else 0 end), 0) as new_customer_sales
      from cf group by ${bucket}`, fields);
    const found = new Map(rows.map((row) => {
      const customers = num(row.customers);
      const newCustomers = num(row.new_customers);
      return [bucketKeyOf(row.bucket), {
        customers,
        new_customers: newCustomers,
        returning_customers: customers - newCustomers,
        orders: num(row.orders),
        new_customer_sales: num(row.new_customer_sales),
      } as Record<string, ReportCell>];
    }));
    const empty = () => ({ customers: 0, new_customers: 0, returning_customers: 0, orders: 0, new_customer_sales: 0 });
    return { rows: bucketRows(range, granularity, found, empty) };
  },
};

// ─── Inventory ──────────────────────────────────────────────────────────────

const LIVE_VARIANT = sql.raw("product_variants.deleted_at is null and p.deleted_at is null");

const inventoryByLocation: SqlReport = {
  kind: "sql",
  async build() {
    return {
      ctes: null,
      select: sql`select l.id as id, l.name as location,
          coalesce(sum(case when stock.on_hand > 0 then 1 else 0 end), 0) as skus,
          coalesce(sum(stock.on_hand), 0) as units_on_hand,
          coalesce(sum(stock.on_hand * stock.price_minor), 0) as retail_value
        from inventory_locations l
        left join (
          select il.location_id, il.on_hand, product_variants.price_minor
          from inventory_levels il
          join product_variants on product_variants.id = il.variant_id
          join products p on p.id = product_variants.product_id
          where ${LIVE_VARIANT}
        ) stock on stock.location_id = l.id
        group by l.id, l.name`,
    };
  },
};

const VARIANT_LABEL = sql`coalesce(${variantOptionLabelSql(productVariants.id)}, '')`;

const inventoryOnHand: SqlReport = {
  kind: "sql",
  async build() {
    return {
      ctes: null,
      select: sql`select il.variant_id || '|' || il.location_id as id, p.name as product,
          ${VARIANT_LABEL} as variant, product_variants.sku as sku, l.name as location,
          il.on_hand as units_on_hand, il.on_hand * product_variants.price_minor as retail_value,
          p.id as link_product_id
        from inventory_levels il
        join product_variants on product_variants.id = il.variant_id
        join products p on p.id = product_variants.product_id
        join inventory_locations l on l.id = il.location_id
        where il.on_hand <> 0 and ${LIVE_VARIANT}`,
    };
  },
};

/**
 * Tracked SKUs at or under their alert level (or sold out), with the units
 * sold in the last 30 days and how many days the available stock lasts at
 * that pace.
 */
const inventoryLowStock: SqlReport = {
  kind: "sql",
  async build(ctx) {
    const since = Math.floor(ctx.now.getTime() / 1000) - 30 * DAY_SECONDS;
    return {
      ctes: null,
      select: sql`select x.*,
          case when x.units_sold_30_days > 0 then x.available * 30.0 / x.units_sold_30_days end as days_of_cover
        from (
          select product_variants.id as id, p.name as product, ${VARIANT_LABEL} as variant,
            product_variants.sku as sku,
            product_variants.stock - product_variants.reserved_stock as available,
            ${effectiveLowStockThresholdSql()} as threshold,
            coalesce((
              select sum(oi.quantity) from order_items oi
              join orders o on o.id = oi.order_id
              where oi.variant_id = product_variants.id and o.deleted_at is null
                and o.created_at >= ${since} and o.status not in (${NON_SALES})
            ), 0) as units_sold_30_days,
            p.id as link_product_id
          from product_variants
          join products p on p.id = product_variants.product_id
          where ${LIVE_VARIANT} and product_variants.track_inventory = 1
            and ${operationalSkuRowPredicate()} and ${buildNeedsRestockCondition()}
        ) x`,
    };
  },
};

/**
 * Per tracked SKU: net units sold in the range, units on hand now,
 * sell-through (sold ÷ (sold + on hand)), the average daily pace and the
 * days of cover it gives. Unsold SKUs stay in the list (0% is dead stock).
 */
const inventorySellThrough: SqlReport = {
  kind: "sql",
  async build(ctx, params) {
    const range = requireRange(params);
    const days = analyticsRangeDays(range);
    return {
      ctes: sql`${salesCtes(ctx, range)},
        vs as (
          select lv.variant_id, sum(lv.quantity - lv.returned_qty) as units_sold
          from lv where lv.gc = 0 and lv.variant_id is not null
          group by lv.variant_id
        )`,
      select: sql`select x.*,
          case when x.units_sold + x.units_on_hand > 0
            then x.units_sold * 100.0 / (x.units_sold + x.units_on_hand) end as sell_through_rate,
          x.units_sold * 1.0 / ${sql.raw(String(days))} as average_daily_sales,
          case when x.units_sold > 0 then x.units_on_hand * ${sql.raw(String(days))} * 1.0 / x.units_sold end as days_of_cover
        from (
          select product_variants.id as id, p.name as product, ${VARIANT_LABEL} as variant,
            product_variants.sku as sku, coalesce(vs.units_sold, 0) as units_sold,
            product_variants.stock as units_on_hand, p.id as link_product_id
          from product_variants
          join products p on p.id = product_variants.product_id
          left join vs on vs.variant_id = product_variants.id
          where ${LIVE_VARIANT} and product_variants.track_inventory = 1 and ${operationalSkuRowPredicate()}
        ) x`,
    };
  },
  finishTotals(totals, params) {
    const sold = num(totals.units_sold);
    const onHand = num(totals.units_on_hand);
    const days = params.range ? analyticsRangeDays(params.range) : 0;
    totals.sell_through_rate = percentOf(sold, sold + onHand);
    totals.average_daily_sales = days > 0 ? sold / days : null;
    totals.days_of_cover = sold > 0 && days > 0 ? (onHand * days) / sold : null;
  },
};

// ─── Finance ────────────────────────────────────────────────────────────────

function ordersInRange(ctx: AnalyticsContext, range: AnalyticsRange): SQL {
  const { start, endExclusive } = analyticsInstantRange(range);
  return sql`o.deleted_at is null and o.created_at >= ${start} and o.created_at < ${endExclusive}
    and o.currency_code = ${ctx.currency.code} and o.shop_currency = ${ctx.currency.code}`;
}

/** Payment records (charges and refunds) of the orders placed in the range, by method, kind and status. */
const financePayments: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const fields = ["payment_method", "kind", "status", "transactions", "amount"] as const;
    const rows = await selectRows(ctx, sql`select p.payment_method as payment_method,
        case when p.payment_type = 'refund' then 'refund' else 'payment' end as kind,
        p.status as status, count(*) as transactions, coalesce(sum(p.amount_minor), 0) as amount
      from orders o join order_payments p on p.order_id = o.id
      where ${ordersInRange(ctx, range)} and p.currency = ${ctx.currency.code}
      group by p.payment_method, case when p.payment_type = 'refund' then 'refund' else 'payment' end, p.status`, fields);
    return {
      rows: rows.map((row) => ({
        id: `${row.payment_method}|${row.kind}|${row.status}`,
        values: {
          payment_method: String(row.payment_method ?? ""),
          kind: String(row.kind ?? ""),
          status: String(row.status ?? ""),
          transactions: num(row.transactions),
          amount: num(row.amount),
        },
      })),
    };
  },
};

/** Refunds on the orders placed in the range: done, in flight and failed, by method. */
const financeRefunds: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const fields = ["payment_method", "orders", "refunds", "refunded", "pending", "failed"] as const;
    const rows = await selectRows(ctx, sql`select p.payment_method as payment_method,
        count(distinct p.order_id) as orders, count(*) as refunds,
        coalesce(sum(case when p.status = 'refunded' then p.amount_minor else 0 end), 0) as refunded,
        coalesce(sum(case when p.status = 'pending' then p.amount_minor else 0 end), 0) as pending,
        coalesce(sum(case when p.status in ('failed', 'cancelled') then p.amount_minor else 0 end), 0) as failed
      from orders o join order_payments p on p.order_id = o.id
      where ${ordersInRange(ctx, range)} and p.payment_type = 'refund' and p.currency = ${ctx.currency.code}
      group by p.payment_method`, fields);
    return {
      rows: rows.map((row) => ({
        id: String(row.payment_method ?? ""),
        values: {
          payment_method: String(row.payment_method ?? ""),
          orders: num(row.orders),
          refunds: num(row.refunds),
          refunded: num(row.refunded),
          pending: num(row.pending),
          failed: num(row.failed),
        },
      })),
    };
  },
};

export const COD_STATES = ["collected", "with_courier", "not_shipped", "returned_to_sender", "refunded"] as const;

/**
 * Cash-on-delivery sales orders of the range by where their cash stands:
 * collected, still out with the courier, not shipped yet, returned to the
 * sender (nothing owed) or refunded. Outstanding is the balance still due on
 * orders that can yet be collected.
 */
const financeCod: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const scope = { ...analyticsInstantRange(range), currency: ctx.currency.code };
    const fields = ["cod_state", "orders", "order_value", "collected", "outstanding"] as const;
    const rows = await selectRows(ctx, sql`with ${salesOrdersCte(scope)},
      cs as (
        select
          case
            when coalesce(ct.cod_status, '') = 'collected' then 'collected'
            when so.status = 'returned' then 'returned_to_sender'
            when so.status = 'refunded' then 'refunded'
            when so.status in ('shipped', 'delivered', 'completed') or so.fulfillment_status <> 'pending' then 'with_courier'
            else 'not_shipped'
          end as cod_state,
          so.total_amount_minor, so.balance_due_minor,
          case when ct.cod_status = 'collected' then coalesce(ct.collected_amount_minor, 0) else 0 end as collected
        from so left join cod_tracking ct on ct.order_id = so.id
        where so.payment_method = 'cod'
      )
      select cs.cod_state as cod_state, count(*) as orders, coalesce(sum(cs.total_amount_minor), 0) as order_value,
        coalesce(sum(cs.collected), 0) as collected,
        coalesce(sum(case when cs.cod_state in ('with_courier', 'not_shipped') then cs.balance_due_minor else 0 end), 0) as outstanding
      from cs group by cs.cod_state`, fields);
    const found = new Map(rows.map((row) => [String(row.cod_state), row]));
    return {
      rows: COD_STATES.map((state) => {
        const row = found.get(state);
        return {
          id: state,
          values: {
            cod_state: state,
            orders: num(row?.orders),
            order_value: num(row?.order_value),
            collected: num(row?.collected),
            outstanding: num(row?.outstanding),
          },
        };
      }),
    };
  },
};

export const GIFT_CARD_MEASURES = [
  "outstanding_balance",
  "unusable_balance",
  "issued_purchase",
  "issued_manual",
  "issued_refund",
  "redeemed",
] as const;

/**
 * Gift card liability now (the balance on active, unexpired cards; balance on
 * disabled or expired cards separately), cards issued in the range by source,
 * and the amount redeemed on orders placed in the range (net of releases).
 */
const financeGiftCards: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const { start, endExclusive } = analyticsInstantRange(range);
    const now = Math.floor(ctx.now.getTime() / 1000);
    const currency = ctx.currency.code;
    const rows = await selectRows(ctx, sql`select 'outstanding_balance' as measure, count(*) as cards,
        coalesce(sum(g.balance_minor), 0) as amount
      from gift_cards g
      where g.status = 'active' and g.currency_code = ${currency} and g.balance_minor > 0
        and (g.expires_at is null or g.expires_at > ${now})
      union all
      select 'unusable_balance', count(*), coalesce(sum(g.balance_minor), 0)
      from gift_cards g
      where g.currency_code = ${currency} and g.balance_minor > 0
        and (g.status = 'disabled' or (g.expires_at is not null and g.expires_at <= ${now}))
      union all
      select 'issued_' || g.source, count(*), coalesce(sum(g.initial_amount_minor), 0)
      from gift_cards g
      where g.status in ('active', 'disabled') and g.created_at >= ${start} and g.created_at < ${endExclusive}
        and g.currency_code = ${currency}
      group by g.source
      union all
      select 'redeemed', count(distinct t.gift_card_id), coalesce(-sum(t.amount_minor), 0)
      from orders o join gift_card_transactions t on t.order_id = o.id
      where ${ordersInRange(ctx, range)} and t.kind in ('redeem', 'release')`, ["measure", "cards", "amount"]);
    const found = new Map(rows.map((row) => [String(row.measure), row]));
    return {
      rows: GIFT_CARD_MEASURES.map((measure, index) => ({
        id: String(index).padStart(2, "0"),
        values: { measure, cards: num(found.get(measure)?.cards), amount: num(found.get(measure)?.amount) },
      })),
    };
  },
};

/** Tax kept on the range's sales by line tax class, plus the tax on shipping. */
const taxes: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const rows = await selectRows(ctx, sql`with ${salesCtes(ctx, range)}
      select coalesce(ts.tax_class_name, '') as tax_class,
        coalesce(sum(lv.gross - lv.disc - lv.returns), 0) as taxable_sales,
        coalesce(sum(lv.kept_tax), 0) as tax_collected
      from lv left join order_item_tax_snapshots ts on ts.order_item_id = lv.line_id
      where lv.gc = 0
      group by coalesce(ts.tax_class_name, '')
      union all
      select '__shipping', coalesce(sum(om.shipping), 0), coalesce(sum(om.shipping_tax), 0)
      from om`, ["tax_class", "taxable_sales", "tax_collected"]);
    return {
      rows: rows
        .filter((row) => String(row.tax_class) !== "__shipping" || num(row.taxable_sales) !== 0 || num(row.tax_collected) !== 0)
        .map((row) => ({
          id: String(row.tax_class ?? ""),
          values: {
            tax_class: String(row.tax_class ?? ""),
            taxable_sales: num(row.taxable_sales),
            tax_collected: num(row.tax_collected),
          },
        })),
    };
  },
};

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * Parcels booked for orders placed in the range, by courier: outcomes,
 * delivery and return rates (of parcels with an outcome), days from order to
 * booking, and for cash-on-delivery parcels days from booking to the cash
 * being recorded (the only delivery timestamp the store keeps).
 */
const deliveryPerformance: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const fields = ["courier", "parcels", "delivered", "returned", "failed", "in_transit", "dispatch_days", "collect_days"] as const;
    const rows = await selectRows(ctx, sql`select
        coalesce(nullif(trim(ds.courier_name), ''), ds.provider_type) as courier,
        count(*) as parcels,
        coalesce(sum(case when ds.status in ('delivered', 'partial_delivered') then 1 else 0 end), 0) as delivered,
        coalesce(sum(case when ds.status = 'returned' then 1 else 0 end), 0) as returned,
        coalesce(sum(case when ds.status in ('delivery_failed', 'failed', 'pickup_failed') then 1 else 0 end), 0) as failed,
        coalesce(sum(case when ds.status not in ('delivered', 'partial_delivered', 'returned', 'delivery_failed', 'failed', 'pickup_failed') then 1 else 0 end), 0) as in_transit,
        avg(case when ds.created_at >= o.created_at then (ds.created_at - o.created_at) * 1.0 / 86400 end) as dispatch_days,
        avg(case when ct.cod_status = 'collected' and ct.collected_at >= ds.created_at
          then (ct.collected_at - ds.created_at) * 1.0 / 86400 end) as collect_days
      from orders o
      join delivery_shipments ds on ds.order_id = o.id
      left join cod_tracking ct on ct.order_id = o.id
      where ${ordersInRange(ctx, range)} and o.status <> 'incomplete'
        and ds.status not in ('cancelled', 'creating')
      group by coalesce(nullif(trim(ds.courier_name), ''), ds.provider_type)`, fields);
    return {
      rows: rows.map((row) => {
        const delivered = num(row.delivered);
        const returned = num(row.returned);
        return {
          id: String(row.courier ?? ""),
          values: {
            courier: String(row.courier ?? ""),
            parcels: num(row.parcels),
            delivered,
            returned,
            failed: num(row.failed),
            in_transit: num(row.in_transit),
            delivery_rate: percentOf(delivered, delivered + returned),
            return_rate: percentOf(returned, delivered + returned),
            average_days_to_dispatch: row.dispatch_days === null || row.dispatch_days === undefined ? null : num(row.dispatch_days),
            average_days_to_collect: row.collect_days === null || row.collect_days === undefined ? null : num(row.collect_days),
          },
        };
      }),
    };
  },
  finishTotals(totals) {
    const delivered = num(totals.delivered);
    const returned = num(totals.returned);
    totals.delivery_rate = percentOf(delivered, delivered + returned);
    totals.return_rate = percentOf(returned, delivered + returned);
  },
};

/**
 * Abandoned checkouts started in the range; reachable ones left a phone;
 * recovered ones were followed by a sales order from that phone within
 * {@link ABANDONED_RECOVERY_WINDOW_DAYS} days of the buyer's last activity.
 * A checkout the buyer finished is deleted at once, so every row here was
 * really abandoned. Rows older than the retention window are gone.
 */
const abandonedCheckouts: ReportImplementation = {
  kind: "rows",
  async rows(ctx, params) {
    const range = requireRange(params);
    const granularity = requireGranularity(params);
    const { start, endExclusive } = analyticsInstantRange(range);
    const bucket = bucketStartSql(merchantDaySql("ac.created_at"), granularity, range);
    const window = ABANDONED_RECOVERY_WINDOW_DAYS * DAY_SECONDS;
    const fields = ["bucket", "abandoned", "reachable", "recovered", "recovered_sales"] as const;
    const rows = await selectRows(ctx, sql`with ac as (
        select a.id, a.customer_phone, a.created_at, a.updated_at, (
          select o.id from orders o
          where a.customer_phone is not null and o.customer_phone = a.customer_phone
            and o.deleted_at is null and o.status not in (${NON_SALES})
            and o.created_at >= a.created_at and o.created_at < a.updated_at + ${window}
          order by o.created_at, o.id limit 1
        ) as order_id
        from abandoned_checkouts a
        where a.created_at >= ${start} and a.created_at < ${endExclusive}
      )
      select ${bucket} as bucket, count(*) as abandoned,
        coalesce(sum(case when ac.customer_phone is not null then 1 else 0 end), 0) as reachable,
        count(ac.order_id) as recovered,
        coalesce(sum(case when ro.currency_code = ${ctx.currency.code} then ro.total_amount_minor else 0 end), 0) as recovered_sales
      from ac left join orders ro on ro.id = ac.order_id
      group by ${bucket}`, fields);
    const found = new Map(rows.map((row) => {
      const reachable = num(row.reachable);
      const recovered = num(row.recovered);
      return [bucketKeyOf(row.bucket), {
        abandoned_checkouts: num(row.abandoned),
        reachable,
        recovered,
        recovery_rate: percentOf(recovered, reachable),
        recovered_sales: num(row.recovered_sales),
      } as Record<string, ReportCell>];
    }));
    const empty = () => ({ abandoned_checkouts: 0, reachable: 0, recovered: 0, recovery_rate: null, recovered_sales: 0 });
    const oldest = Math.floor(ctx.now.getTime() / 1000) - ABANDONED_RETENTION_DAYS * DAY_SECONDS;
    return {
      rows: bucketRows(range, granularity, found, empty),
      notes: start < oldest ? ["abandoned_retention"] : [],
    };
  },
  finishTotals(totals) {
    totals.recovery_rate = percentOf(num(totals.recovered), num(totals.reachable));
  },
};

// ─── Profit ─────────────────────────────────────────────────────────────────

/**
 * Gross profit by product from the unit cost recorded on each order line at
 * the time of sale. Lines without a recorded cost are left out of cost and
 * profit (never priced at today's cost); coverage says how much was costed.
 */
const profitByProduct: SqlReport = {
  kind: "sql",
  async build(ctx, params) {
    return {
      ctes: salesCtes(ctx, requireRange(params), { unitCost: true }),
      select: sql`select x.*,
          case when x.costed_net_sales > 0 then x.gross_profit * 100.0 / x.costed_net_sales end as gross_margin,
          case when x.net_items_sold > 0 then x.costed_items * 100.0 / x.net_items_sold end as cost_coverage
        from (
          select lv.product_id as id, ${sql.raw(PRODUCT_NAME)} as product,
            coalesce(sum(lv.quantity - lv.returned_qty), 0) as net_items_sold,
            coalesce(sum(case when lv.unit_cost is not null then lv.quantity - lv.returned_qty else 0 end), 0) as costed_items,
            coalesce(sum(lv.gross - lv.disc - lv.returns), 0) as net_sales,
            coalesce(sum(case when lv.unit_cost is not null
              then lv.unit_cost * (lv.quantity - lv.returned_qty) else 0 end), 0) as cost_of_goods,
            coalesce(sum(case when lv.unit_cost is not null
              then lv.gross - lv.disc - lv.returns - lv.unit_cost * (lv.quantity - lv.returned_qty) else 0 end), 0) as gross_profit,
            coalesce(sum(case when lv.unit_cost is not null then lv.gross - lv.disc - lv.returns else 0 end), 0) as costed_net_sales,
            lv.product_id as link_product_id
          from lv left join products p on p.id = lv.product_id
          where lv.gc = 0
          group by lv.product_id, p.name
        ) x`,
    };
  },
  finishTotals(totals) {
    const profit = num(totals.gross_profit);
    const costedSales = profit + num(totals.cost_of_goods);
    totals.gross_margin = percentOf(profit, costedSales);
    totals.cost_coverage = percentOf(num(totals.costed_items), num(totals.net_items_sold));
  },
};

export const REPORT_IMPLEMENTATIONS: Record<AnalyticsReportId, ReportImplementation> = {
  sales_over_time: salesOverTime,
  sales_by_product: salesByProduct,
  sales_by_variant: salesByVariant,
  sales_by_category: salesByCategory,
  sales_by_brand: salesByBrand,
  sales_by_collection: salesByCollection,
  sales_by_discount: salesByDiscount,
  sales_by_channel: salesByChannel,
  sales_by_payment_method: salesByPaymentMethod,
  sales_by_city: salesByCity,
  sales_by_delivery_zone: salesByDeliveryZone,
  sales_by_location: salesByLocation,
  customers_top: customersTop,
  customers_over_time: customersOverTime,
  inventory_by_location: inventoryByLocation,
  inventory_on_hand: inventoryOnHand,
  inventory_low_stock: inventoryLowStock,
  inventory_sell_through: inventorySellThrough,
  finance_payments: financePayments,
  finance_refunds: financeRefunds,
  finance_cod: financeCod,
  finance_gift_cards: financeGiftCards,
  taxes,
  delivery_performance: deliveryPerformance,
  abandoned_checkouts: abandonedCheckouts,
  profit_by_product: profitByProduct,
};

export type { AnalyticsGranularity };
