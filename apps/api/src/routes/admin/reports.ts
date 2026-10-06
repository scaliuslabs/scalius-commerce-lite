// Admin OpenAPI routes for Analytics: the overview, the report catalog, one
// report page, and a report's CSV export.
//
// The whole family needs `dashboard.analytics` (route-permissions/dashboard.ts).
// Reports that name customers also need `customers.view`, checked here at the
// boundary. Money leaves as decimal major units of the store currency,
// converted once from the integer minor units the service computes in.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createAnalyticsContext,
  exportAnalyticsReportCsv,
  getAnalyticsOverviewForRequest,
  getAnalyticsReportPage,
  listAnalyticsReports,
  type AnalyticsAccess,
  type OverviewBreakdownRow,
  type OverviewPeriod,
  type ReportCell,
  type SalesMeasures,
} from "@scalius/core/modules/analytics";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  ANALYTICS_COMPARISONS,
  ANALYTICS_GRANULARITIES,
} from "@scalius/shared/analytics-period";
import {
  ANALYTICS_REPORT_CATEGORIES,
  ANALYTICS_REPORT_IDS,
  ANALYTICS_REPORT_MAX_PAGE_SIZE,
  ANALYTICS_REPORT_MAX_ROWS,
  type AnalyticsReportDefinition,
} from "@scalius/shared/analytics-reports";
import { fromMinor } from "@scalius/shared/money";
import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { REPORT_CSV_MAX_BYTES } from "@scalius/core/modules/analytics";
import { storeTimeZoneOf } from "../../utils/store-time-zone";

const app = new OpenAPIHono<{ Bindings: Env }>();

/** Breakdown rows shown per dimension; the rest are summed into one `__other` row. */
const BREAKDOWN_TOP_ROWS = 8;
const TEXT_MAX = 300;

function access(c: Context): AnalyticsAccess {
  const permissions: ReadonlySet<string> = c.get("adminPermissions") ?? new Set();
  return {
    customers: permissions.has(PERMISSIONS.CUSTOMERS_VIEW),
    costs: permissions.has(PERMISSIONS.PRODUCTS_VIEW_COSTS),
  };
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ from: dateKey, to: dateKey });

const rangeQuery = {
  from: dateKey.optional().openapi({ description: "First day (YYYY-MM-DD, store calendar: the store time zone). Defaults to the last 30 days." }),
  to: dateKey.optional().openapi({ description: "Last day, inclusive (YYYY-MM-DD). At most 731 days after `from`." }),
  granularity: z.enum(ANALYTICS_GRANULARITIES).optional().openapi({
    description: "Time buckets: day (ranges up to 92 days), week (Sunday weeks) or month. Defaults by range length.",
  }),
};

const measuresSchema = z.object({
  orders: z.number().int(),
  grossSales: z.number(),
  discounts: z.number(),
  returns: z.number(),
  netSales: z.number(),
  shipping: z.number(),
  taxes: z.number(),
  totalSales: z.number(),
  netItemsSold: z.number().int(),
  averageOrderValue: z.number(),
});

const breakdownRowSchema = measuresSchema.extend({
  key: z.string().max(TEXT_MAX),
  label: z.string().max(TEXT_MAX),
});

const breakdownList = z.array(breakdownRowSchema).max(BREAKDOWN_TOP_ROWS + 1);

/** The measures a time bucket carries (average order value is (gross − discounts) ÷ orders). */
const seriesMeasuresSchema = z.object({
  orders: z.number().int(),
  grossSales: z.number(),
  discounts: z.number(),
  returns: z.number(),
  netSales: z.number(),
  totalSales: z.number(),
});

const periodSchema = z.object({
  range: rangeSchema,
  totals: measuresSchema,
  customers: z.object({
    customers: z.number().int(),
    newCustomers: z.number().int(),
    returningCustomers: z.number().int(),
    repeatPurchaseRate: z.number().nullable(),
  }),
  payments: z.object({
    codOrders: z.number().int(),
    prepaidOrders: z.number().int(),
    codShare: z.number().nullable(),
    returnedToSender: z.number().int(),
    codDelivered: z.number().int(),
    rtsRate: z.number().nullable(),
    refunded: z.number(),
  }),
  cancellations: z.object({
    placed: z.number().int(),
    cancelled: z.number().int(),
    cancellationRate: z.number().nullable(),
  }),
  otherCurrencyOrders: z.number().int(),
});

const currencySchema = z.object({ code: z.string().length(3), decimalPlaces: z.number().int() });

const overviewSchema = z.object({
  currency: currencySchema,
  /** The store's IANA time zone: every day, week and month is a store calendar one in it. */
  timeZone: z.string().max(64),
  granularity: z.enum(ANALYTICS_GRANULARITIES),
  comparison: z.enum(ANALYTICS_COMPARISONS),
  current: periodSchema,
  previous: periodSchema.nullable(),
  /** The current range's breakdowns, largest total sales first. */
  breakdowns: z.object({
    channel: breakdownList,
    paymentMethod: breakdownList,
    city: breakdownList,
    deliveryZone: breakdownList,
    location: breakdownList,
  }),
  /** One point per bucket; `key` is the bucket's first day, `previousKey` its comparison bucket's. */
  series: z.array(z.object({
    key: dateKey,
    current: seriesMeasuresSchema,
    previousKey: dateKey.nullable(),
    previous: seriesMeasuresSchema.nullable(),
  })).max(106),
});

const columnSchema = z.object({
  key: z.string().max(64),
  type: z.enum(["text", "enum", "money", "count", "number", "percent", "date", "days"]),
  summable: z.boolean().optional(),
  enum: z.string().max(64).optional(),
});

const reportDefinitionSchema = z.object({
  id: z.enum(ANALYTICS_REPORT_IDS),
  category: z.enum(ANALYTICS_REPORT_CATEGORIES as [string, ...string[]]),
  period: z.enum(["range", "snapshot"]),
  granularity: z.boolean().optional(),
  columns: z.array(columnSchema).max(20),
  defaultSort: z.object({ key: z.string().max(64), direction: z.enum(["asc", "desc"]) }),
  requiresCustomerAccess: z.boolean().optional(),
  requiresCostAccess: z.boolean().optional(),
  rowLink: z.enum(["product", "variant"]).optional(),
});

const catalogSchema = z.object({
  reports: z.array(reportDefinitionSchema.extend({
    available: z.boolean(),
    unavailableReason: z.enum(["customer_access", "cost_access"]).nullable(),
  })).max(64),
});

const cellSchema = z.union([z.number(), z.string().max(TEXT_MAX), z.null()]);

const reportPageSchema = z.object({
  report: reportDefinitionSchema,
  currency: currencySchema,
  range: rangeSchema.nullable(),
  granularity: z.enum(ANALYTICS_GRANULARITIES).nullable(),
  sort: z.object({ key: z.string().max(64), direction: z.enum(["asc", "desc"]) }),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRows: z.number().int(),
  totalPages: z.number().int(),
  rows: z.array(z.object({
    id: z.string().max(TEXT_MAX),
    productId: z.string().max(TEXT_MAX).nullable().optional(),
    values: z.record(z.string(), cellSchema),
  })).max(ANALYTICS_REPORT_MAX_PAGE_SIZE),
  totals: z.record(z.string(), cellSchema),
  notes: z.array(z.string().max(64)).max(8),
});

// ─── Edge projection (minor → major units) ──────────────────────────────────

function measuresView(measures: SalesMeasures, decimals: number) {
  const money = (minor: number) => fromMinor(minor, decimals);
  return {
    orders: measures.orders,
    grossSales: money(measures.grossSales),
    discounts: money(measures.discounts),
    returns: money(measures.returns),
    netSales: money(measures.netSales),
    shipping: money(measures.shipping),
    taxes: money(measures.taxes),
    totalSales: money(measures.totalSales),
    netItemsSold: measures.netItemsSold,
    averageOrderValue: money(measures.averageOrderValue),
  };
}

const ZERO_MEASURES: SalesMeasures = {
  orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, shipping: 0, taxes: 0, totalSales: 0,
  netItemsSold: 0, averageOrderValue: 0,
};

/** The largest rows, then everything else as one `__other` row so the list still adds up. */
function topBreakdown(rows: readonly OverviewBreakdownRow[], decimals: number) {
  const head = rows.slice(0, BREAKDOWN_TOP_ROWS);
  const tail = rows.slice(BREAKDOWN_TOP_ROWS);
  const view = (row: OverviewBreakdownRow) => ({
    key: row.key.slice(0, TEXT_MAX),
    label: row.label.slice(0, TEXT_MAX),
    ...measuresView(row, decimals),
  });
  if (tail.length === 0) return head.map(view);
  const other = tail.reduce((sum, row) => {
    const next = { ...sum };
    for (const key of Object.keys(ZERO_MEASURES) as Array<keyof SalesMeasures>) next[key] = sum[key] + row[key];
    return next;
  }, { ...ZERO_MEASURES });
  other.averageOrderValue = other.orders > 0 ? Math.round((other.grossSales - other.discounts) / other.orders) : 0;
  return [...head.map(view), { key: "__other", label: "", ...measuresView(other, decimals) }];
}

function periodView(period: OverviewPeriod, decimals: number) {
  return {
    range: period.range,
    totals: measuresView(period.totals, decimals),
    customers: period.customers,
    payments: { ...period.payments, refunded: fromMinor(period.payments.refunded, decimals) },
    cancellations: period.cancellations,
    otherCurrencyOrders: period.otherCurrencyOrders,
  };
}

function breakdownsView(period: OverviewPeriod, decimals: number) {
  return {
    channel: topBreakdown(period.breakdowns.channel, decimals),
    paymentMethod: topBreakdown(period.breakdowns.paymentMethod, decimals),
    city: topBreakdown(period.breakdowns.city, decimals),
    deliveryZone: topBreakdown(period.breakdowns.deliveryZone, decimals),
    location: topBreakdown(period.breakdowns.location, decimals),
  };
}

function seriesMeasuresView(measures: SalesMeasures, decimals: number) {
  const money = (minor: number) => fromMinor(minor, decimals);
  return {
    orders: measures.orders,
    grossSales: money(measures.grossSales),
    discounts: money(measures.discounts),
    returns: money(measures.returns),
    netSales: money(measures.netSales),
    totalSales: money(measures.totalSales),
  };
}

function cellsView(report: AnalyticsReportDefinition, values: Record<string, ReportCell>, decimals: number) {
  return Object.fromEntries(report.columns.map((column) => {
    const value = values[column.key] ?? null;
    if (value === null) return [column.key, null];
    if (column.type === "money") return [column.key, fromMinor(Number(value), decimals)];
    if (typeof value === "string") return [column.key, value.slice(0, TEXT_MAX)];
    return [column.key, value];
  }));
}

function definitionView(report: AnalyticsReportDefinition) {
  return {
    id: report.id as (typeof ANALYTICS_REPORT_IDS)[number],
    category: report.category,
    period: report.period,
    ...(report.granularity ? { granularity: true } : {}),
    columns: report.columns.map((column) => ({
      key: column.key,
      type: column.type,
      ...(column.summable ? { summable: true } : {}),
      ...(column.enum ? { enum: column.enum } : {}),
    })),
    defaultSort: report.defaultSort,
    ...(report.requiresCustomerAccess ? { requiresCustomerAccess: true } : {}),
    ...(report.requiresCostAccess ? { requiresCostAccess: true } : {}),
    ...(report.rowLink ? { rowLink: report.rowLink } : {}),
  };
}

// ─── GET /overview ─────────────────────────────────────────────────────────

const overviewRoute = createRoute({
  operationId: "dashboard.reports.overview",
  method: "get",
  path: "/overview",
  tags: ["Admin - Analytics"],
  summary: "Get the analytics overview",
  description: "Sales KPIs for a store-calendar date range and a comparison period: gross sales, discounts, returns, net sales, shipping, taxes, total sales, orders, average order value, units, new vs returning customers, repeat purchase rate, COD share, return-to-sender rate, cancellation rate and refunds, plus sales over time and breakdowns by channel, payment method, city, delivery zone and stock location. Orders placed in the range count (not incomplete hosted payments, not cancelled); returns and refunds count against the order's placement date. Money is decimal store currency.",
  request: {
    query: z.object({
      ...rangeQuery,
      comparison: z.enum(ANALYTICS_COMPARISONS).optional().openapi({
        description: "Compare with the previous period of equal length (default), the same days last year, or nothing.",
      }),
    }),
  },
  responses: {
    200: { description: "Analytics overview", content: { "application/json": { schema: successEnvelope(overviewSchema) } } },
    ...errorResponses,
  },
});

app.openapi(overviewRoute, async (c) => {
  const query = c.req.valid("query");
  const ctx = await createAnalyticsContext(c.get("db"), storeTimeZoneOf(c.env));
  const overview = await getAnalyticsOverviewForRequest(ctx, query);
  const decimals = overview.currency.decimalPlaces;
  return ok(c, {
    currency: overview.currency,
    timeZone: ctx.timeZone,
    granularity: overview.granularity,
    comparison: overview.comparison,
    current: periodView(overview.current, decimals),
    previous: overview.previous ? periodView(overview.previous, decimals) : null,
    breakdowns: breakdownsView(overview.current, decimals),
    series: overview.series.map((point) => ({
      key: point.key,
      current: seriesMeasuresView(point.current, decimals),
      previousKey: point.previous?.key ?? null,
      previous: point.previous ? seriesMeasuresView(point.previous.measures, decimals) : null,
    })),
  });
});

// ─── GET / (catalog) ───────────────────────────────────────────────────────

const catalogRoute = createRoute({
  operationId: "dashboard.reports.list",
  method: "get",
  path: "/",
  tags: ["Admin - Analytics"],
  summary: "List analytics reports",
  description: "Every report with its columns, default sort and whether this caller can run it now (customer reports need the View customers permission; profit reports need the View product costs permission and unit costs recorded on order lines).",
  responses: {
    200: { description: "Report catalog", content: { "application/json": { schema: successEnvelope(catalogSchema) } } },
    ...errorResponses,
  },
});

app.openapi(catalogRoute, async (c) => {
  const ctx = await createAnalyticsContext(c.get("db"), storeTimeZoneOf(c.env));
  const reports = await listAnalyticsReports(ctx, access(c));
  return ok(c, {
    reports: reports.map((report) => ({
      ...definitionView(report),
      available: report.available,
      unavailableReason: report.unavailableReason,
    })),
  });
});

// ─── GET /{reportId} ───────────────────────────────────────────────────────

const reportPathParams = z.object({
  reportId: z.enum(ANALYTICS_REPORT_IDS).openapi({ param: { name: "reportId", in: "path" }, description: "Report id from the catalog" }),
});

const reportQuery = z.object({
  ...rangeQuery,
  sort: z.string().max(64).optional().openapi({ description: "Column key to sort by; unknown keys use the report's default" }),
  direction: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).max(ANALYTICS_REPORT_MAX_ROWS).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(ANALYTICS_REPORT_MAX_PAGE_SIZE).optional().default(50),
});

const reportRoute = createRoute({
  operationId: "dashboard.reports.get",
  method: "get",
  path: "/{reportId}",
  tags: ["Admin - Analytics"],
  summary: "Run an analytics report",
  description: `One sorted page (at most ${ANALYTICS_REPORT_MAX_PAGE_SIZE} rows, ${ANALYTICS_REPORT_MAX_ROWS} rows deep) of a catalogued report for a store-calendar date range, with totals over all rows. Money is decimal store currency; percent values are 0–100.`,
  request: { params: reportPathParams, query: reportQuery },
  responses: {
    200: { description: "Report page", content: { "application/json": { schema: successEnvelope(reportPageSchema) } } },
    ...errorResponses,
  },
});

app.openapi(reportRoute, async (c) => {
  const { reportId } = c.req.valid("param");
  const query = c.req.valid("query");
  const ctx = await createAnalyticsContext(c.get("db"), storeTimeZoneOf(c.env));
  const page = await getAnalyticsReportPage(ctx, reportId, query, access(c));
  const decimals = ctx.currency.decimalPlaces;
  return ok(c, {
    report: definitionView(page.report),
    currency: { code: ctx.currency.code, decimalPlaces: decimals },
    range: page.range,
    granularity: page.granularity,
    sort: page.sort,
    page: page.page,
    pageSize: page.pageSize,
    totalRows: page.totalRows,
    totalPages: Math.max(1, Math.ceil(Math.min(page.totalRows, ANALYTICS_REPORT_MAX_ROWS) / page.pageSize)),
    rows: page.rows.map((row) => ({
      id: row.id.slice(0, TEXT_MAX),
      ...(page.report.rowLink ? { productId: row.productId ?? null } : {}),
      values: cellsView(page.report, row.values, decimals),
    })),
    totals: cellsView(page.report, page.totals, decimals),
    notes: page.notes.slice(0, 8),
  });
});

// ─── GET /{reportId}/export ────────────────────────────────────────────────

const exportRoute = createRoute({
  operationId: "dashboard.reports.export",
  method: "get",
  path: "/{reportId}/export",
  tags: ["Admin - Analytics"],
  summary: "Export an analytics report as CSV",
  description: `The whole report in the requested order (at most ${ANALYTICS_REPORT_MAX_ROWS} rows and 16 MB) with a totals row, as a private spreadsheet-safe CSV. X-Export-Limited says when the file stopped early.`,
  request: {
    params: reportPathParams,
    query: z.object({
      ...rangeQuery,
      sort: z.string().max(64).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: { description: "Report CSV", content: { "text/csv": { schema: z.string() } } },
    ...errorResponses,
  },
});

function csvStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

app.openapi(exportRoute, async (c) => {
  const { reportId } = c.req.valid("param");
  const query = c.req.valid("query");
  const ctx = await createAnalyticsContext(c.get("db"), storeTimeZoneOf(c.env));
  const exported = await exportAnalyticsReportCsv(ctx, reportId, query, access(c));
  return c.body(csvStream(exported.artifact.chunks), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${exported.filename}"`,
    "Content-Length": String(exported.artifact.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Export-Limited": exported.truncatedBy === "none" ? "false" : "true",
    "X-Export-Truncated-By": exported.truncatedBy,
    "X-Export-Artifact-Bytes": String(exported.artifact.byteLength),
    "X-Export-Max-Bytes": String(REPORT_CSV_MAX_BYTES),
    "X-Export-Row-Count": String(exported.artifact.rowCount),
    "X-Export-Total-Count": String(exported.totalRows),
  });
});

export { app as adminReportRoutes };
