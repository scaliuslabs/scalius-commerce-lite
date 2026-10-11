import { sql, type SQL } from "drizzle-orm";
import { analyticsInstantRange, type AnalyticsGranularity, type AnalyticsRange } from "@scalius/shared/analytics-period";
import type { AnalyticsContext } from "./context";
import { overviewReadRanges } from "./overview-buckets";
import { bucketStartSql, merchantDaySql, orderMeasuresSql, scopeOffsets } from "./sales-sql";

const MEASURES = ["order_count", "gross", "disc", "returns", "shipping", "taxes", "net_units"] as const;
const measures = (alias: string) => sql.raw(MEASURES.map((name) => `${alias}.${name}`).join(", "));
const intervalsJson = (ranges: readonly (readonly [number, number])[]) => JSON.stringify(ranges.map(([lo, hi]) => ({ lo, hi })));

/** Exact merchant-day cuts share the overview's DST, fractional-offset and pre-epoch rules. */
export function salesOverTimeSql(ctx: AnalyticsContext, range: AnalyticsRange, granularity: AnalyticsGranularity): SQL {
  const instants = analyticsInstantRange(range, ctx.timeZone);
  const offsets = scopeOffsets(ctx.timeZone, instants);
  const ranges = overviewReadRanges(instants, offsets);
  const bucket = bucketStartSql(merchantDaySql("r.created_at", offsets), granularity, range, ctx.weekStart);
  return sql`with r as (
    select b.bucket_start as created_at, ${measures("b")}
    from json_each(${intervalsJson(ranges.quarterHours)}) q cross join analytics_sales_buckets b
    where b.grain_seconds = 900 and b.dimension_kind = 'total' and b.shop_currency = ${ctx.currency.code}
      and b.bucket_start >= cast(json_extract(q.value, '$.lo') as bigint)
      and b.bucket_start < cast(json_extract(q.value, '$.hi') as bigint)
      and b.order_count > 0
    union all
    select f.created_at, ${measures("f")}
    from json_each(${intervalsJson(ranges.dayEdges)}) e cross join analytics_order_facts f
    where f.created_at >= cast(json_extract(e.value, '$.lo') as bigint)
      and f.created_at < cast(json_extract(e.value, '$.hi') as bigint)
      and f.shop_currency = ${ctx.currency.code} and f.order_count = 1
  )
  select ${bucket} as bucket, ${orderMeasuresSql("r", true)}
  from r group by ${bucket}`;
}
