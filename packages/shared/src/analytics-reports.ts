// The report catalog: every report's id, category, columns and defaults. The
// API runs and validates reports by these ids; the dashboard draws headings,
// formats cells and words enum values from the same list, so the two can't
// disagree about a column.

export type AnalyticsReportCategory = "sales" | "customers" | "inventory" | "finance" | "operations" | "profit";

export const ANALYTICS_REPORT_CATEGORIES: readonly AnalyticsReportCategory[] = [
  "sales",
  "customers",
  "inventory",
  "finance",
  "operations",
  "profit",
];

/**
 * How a cell is shown. `money` is decimal major units of the report currency,
 * `percent` is 0–100, `days` a decimal day count, `date` a merchant date key,
 * `enum` a code the dashboard words (its `enum` names the vocabulary).
 */
export type AnalyticsColumnType = "text" | "enum" | "money" | "count" | "number" | "percent" | "date" | "days";

export type AnalyticsEnumVocabulary =
  | "channel"
  | "paymentMethod"
  | "paymentKind"
  | "paymentStatus"
  | "codState"
  | "giftCardMeasure"
  | "discountMethod";

export interface AnalyticsColumn {
  key: string;
  type: AnalyticsColumnType;
  /** Whether the totals row adds this column up (counts of distinct orders across products do not). */
  summable?: boolean;
  enum?: AnalyticsEnumVocabulary;
}

export interface AnalyticsReportDefinition {
  id: string;
  category: AnalyticsReportCategory;
  /** `range` reports read a date range; `snapshot` reports read the store as it is now. */
  period: "range" | "snapshot";
  /** Rows are time buckets (day, week or month). */
  granularity?: true;
  columns: readonly AnalyticsColumn[];
  defaultSort: { key: string; direction: "asc" | "desc" };
  /** Rows name customers: also needs the "View customers" permission. */
  requiresCustomerAccess?: true;
  /** Rows show unit costs or profit: also needs the "View product costs" permission. */
  requiresCostAccess?: true;
  /** What a row's id opens in the dashboard. */
  rowLink?: "product" | "variant";
}

const money = (key: string): AnalyticsColumn => ({ key, type: "money", summable: true });
const count = (key: string): AnalyticsColumn => ({ key, type: "count", summable: true });
const text = (key: string): AnalyticsColumn => ({ key, type: "text" });

/** Order-level sales measures (each order counted once per row). */
const ORDER_SALES_COLUMNS: readonly AnalyticsColumn[] = [
  count("orders"),
  money("gross_sales"),
  money("discounts"),
  money("returns"),
  money("net_sales"),
  money("shipping"),
  money("taxes"),
  money("total_sales"),
  { key: "average_order_value", type: "money" },
];

/** Line-level sales measures (an order with two products counts for both). */
const LINE_SALES_COLUMNS: readonly AnalyticsColumn[] = [
  { key: "orders", type: "count" },
  count("net_items_sold"),
  money("gross_sales"),
  money("discounts"),
  money("returns"),
  money("net_sales"),
  money("taxes"),
  money("total_sales"),
];

const byNetSales = { key: "net_sales", direction: "desc" } as const;
const byTotalSales = { key: "total_sales", direction: "desc" } as const;
const byPeriod = { key: "period", direction: "asc" } as const;

export const ANALYTICS_REPORTS = [
  {
    id: "sales_over_time",
    category: "sales",
    period: "range",
    granularity: true,
    columns: [{ key: "period", type: "date" }, ...ORDER_SALES_COLUMNS, count("net_items_sold")],
    defaultSort: byPeriod,
  },
  {
    id: "sales_by_product",
    category: "sales",
    period: "range",
    columns: [text("product"), ...LINE_SALES_COLUMNS],
    defaultSort: byNetSales,
    rowLink: "product",
  },
  {
    id: "sales_by_variant",
    category: "sales",
    period: "range",
    columns: [text("product"), text("variant"), text("sku"), ...LINE_SALES_COLUMNS],
    defaultSort: byNetSales,
    rowLink: "variant",
  },
  {
    id: "sales_by_category",
    category: "sales",
    period: "range",
    columns: [text("category"), ...LINE_SALES_COLUMNS],
    defaultSort: byNetSales,
  },
  {
    id: "sales_by_brand",
    category: "sales",
    period: "range",
    columns: [text("brand"), ...LINE_SALES_COLUMNS],
    defaultSort: byNetSales,
  },
  {
    id: "sales_by_collection",
    category: "sales",
    period: "range",
    // A product sits in several collections, so no column adds up across rows.
    columns: [text("collection"), ...LINE_SALES_COLUMNS.map(({ key, type }) => ({ key, type }))],
    defaultSort: byNetSales,
  },
  {
    id: "sales_by_discount",
    category: "sales",
    period: "range",
    columns: [
      text("discount"),
      text("code"),
      { key: "method", type: "enum", enum: "discountMethod" },
      count("orders"),
      money("discount_amount"),
      money("gross_sales"),
      money("net_sales"),
      money("total_sales"),
    ],
    defaultSort: { key: "discount_amount", direction: "desc" },
  },
  {
    id: "sales_by_channel",
    category: "sales",
    period: "range",
    columns: [{ key: "channel", type: "enum", enum: "channel" }, text("source"), ...ORDER_SALES_COLUMNS],
    defaultSort: byTotalSales,
  },
  {
    id: "sales_by_payment_method",
    category: "sales",
    period: "range",
    columns: [{ key: "payment_method", type: "enum", enum: "paymentMethod" }, ...ORDER_SALES_COLUMNS],
    defaultSort: byTotalSales,
  },
  {
    id: "sales_by_city",
    category: "sales",
    period: "range",
    columns: [text("city"), ...ORDER_SALES_COLUMNS],
    defaultSort: byTotalSales,
  },
  {
    id: "sales_by_delivery_zone",
    category: "sales",
    period: "range",
    columns: [text("delivery_zone"), ...ORDER_SALES_COLUMNS],
    defaultSort: byTotalSales,
  },
  {
    id: "sales_by_location",
    category: "sales",
    period: "range",
    columns: [text("location"), ...ORDER_SALES_COLUMNS],
    defaultSort: byTotalSales,
  },
  {
    id: "customers_top",
    category: "customers",
    period: "range",
    columns: [
      text("customer"),
      text("phone"),
      count("orders"),
      money("total_sales"),
      money("net_sales"),
      { key: "average_order_value", type: "money" },
      { key: "first_order", type: "date" },
      { key: "last_order", type: "date" },
    ],
    defaultSort: byTotalSales,
    requiresCustomerAccess: true,
  },
  {
    id: "customers_over_time",
    category: "customers",
    period: "range",
    granularity: true,
    columns: [
      { key: "period", type: "date" },
      { key: "customers", type: "count" },
      count("new_customers"),
      { key: "returning_customers", type: "count" },
      count("orders"),
      money("new_customer_sales"),
    ],
    defaultSort: byPeriod,
  },
  {
    id: "inventory_by_location",
    category: "inventory",
    period: "snapshot",
    columns: [text("location"), count("skus"), count("units_on_hand"), money("retail_value")],
    defaultSort: { key: "units_on_hand", direction: "desc" },
  },
  {
    id: "inventory_on_hand",
    category: "inventory",
    period: "snapshot",
    columns: [text("product"), text("variant"), text("sku"), text("location"), count("units_on_hand"), money("retail_value")],
    defaultSort: { key: "units_on_hand", direction: "desc" },
    rowLink: "variant",
  },
  {
    id: "inventory_low_stock",
    category: "inventory",
    period: "snapshot",
    columns: [
      text("product"),
      text("variant"),
      text("sku"),
      count("available"),
      { key: "threshold", type: "count" },
      count("units_sold_30_days"),
      { key: "days_of_cover", type: "days" },
    ],
    defaultSort: { key: "available", direction: "asc" },
    rowLink: "variant",
  },
  {
    id: "inventory_sell_through",
    category: "inventory",
    period: "range",
    columns: [
      text("product"),
      text("variant"),
      text("sku"),
      count("units_sold"),
      count("units_on_hand"),
      { key: "sell_through_rate", type: "percent" },
      { key: "average_daily_sales", type: "number" },
      { key: "days_of_cover", type: "days" },
    ],
    defaultSort: { key: "units_sold", direction: "desc" },
    rowLink: "variant",
  },
  {
    id: "finance_payments",
    category: "finance",
    period: "range",
    columns: [
      { key: "payment_method", type: "enum", enum: "paymentMethod" },
      { key: "kind", type: "enum", enum: "paymentKind" },
      { key: "status", type: "enum", enum: "paymentStatus" },
      count("transactions"),
      money("amount"),
    ],
    defaultSort: { key: "amount", direction: "desc" },
  },
  {
    id: "finance_refunds",
    category: "finance",
    period: "range",
    columns: [
      { key: "payment_method", type: "enum", enum: "paymentMethod" },
      count("orders"),
      count("refunds"),
      money("refunded"),
      money("pending"),
      money("failed"),
    ],
    defaultSort: { key: "refunded", direction: "desc" },
  },
  {
    id: "finance_cod",
    category: "finance",
    period: "range",
    columns: [
      { key: "cod_state", type: "enum", enum: "codState" },
      count("orders"),
      money("order_value"),
      money("collected"),
      money("outstanding"),
    ],
    defaultSort: { key: "orders", direction: "desc" },
  },
  {
    id: "finance_gift_cards",
    category: "finance",
    period: "range",
    columns: [{ key: "measure", type: "enum", enum: "giftCardMeasure" }, { key: "cards", type: "count" }, { key: "amount", type: "money" }],
    defaultSort: { key: "measure", direction: "asc" },
  },
  {
    id: "taxes",
    category: "finance",
    period: "range",
    columns: [text("tax_class"), money("taxable_sales"), money("tax_collected")],
    defaultSort: { key: "tax_collected", direction: "desc" },
  },
  {
    id: "delivery_performance",
    category: "operations",
    period: "range",
    columns: [
      text("courier"),
      count("parcels"),
      count("delivered"),
      count("returned"),
      count("failed"),
      count("in_transit"),
      { key: "delivery_rate", type: "percent" },
      { key: "return_rate", type: "percent" },
      { key: "average_days_to_dispatch", type: "days" },
      { key: "average_days_to_collect", type: "days" },
    ],
    defaultSort: { key: "parcels", direction: "desc" },
  },
  {
    id: "abandoned_checkouts",
    category: "operations",
    period: "range",
    granularity: true,
    columns: [
      { key: "period", type: "date" },
      count("abandoned_checkouts"),
      count("reachable"),
      count("recovered"),
      { key: "recovery_rate", type: "percent" },
      money("recovered_sales"),
    ],
    defaultSort: byPeriod,
  },
  {
    id: "profit_by_product",
    category: "profit",
    period: "range",
    columns: [
      text("product"),
      count("net_items_sold"),
      count("costed_items"),
      money("net_sales"),
      money("cost_of_goods"),
      money("gross_profit"),
      { key: "gross_margin", type: "percent" },
      { key: "cost_coverage", type: "percent" },
    ],
    defaultSort: { key: "gross_profit", direction: "desc" },
    requiresCostAccess: true,
    rowLink: "product",
  },
] as const satisfies readonly AnalyticsReportDefinition[];

export type AnalyticsReportId = (typeof ANALYTICS_REPORTS)[number]["id"];

export const ANALYTICS_REPORT_IDS = ANALYTICS_REPORTS.map((report) => report.id) as [
  AnalyticsReportId,
  ...AnalyticsReportId[],
];

const REPORTS_BY_ID = new Map<string, AnalyticsReportDefinition>(
  ANALYTICS_REPORTS.map((report) => [report.id, report]),
);

export function isAnalyticsReportId(value: unknown): value is AnalyticsReportId {
  return typeof value === "string" && REPORTS_BY_ID.has(value);
}

export function analyticsReport(id: AnalyticsReportId): AnalyticsReportDefinition {
  return REPORTS_BY_ID.get(id)!;
}

/** Report rows per page, and the deepest row a page or export may reach. */
export const ANALYTICS_REPORT_MAX_PAGE_SIZE = 100;
export const ANALYTICS_REPORT_MAX_ROWS = 10_000;

/** Values of the enum vocabularies, for validation and wording completeness tests. */
export const ANALYTICS_ENUM_VALUES: Record<AnalyticsEnumVocabulary, readonly string[]> = {
  channel: ["online_store", "admin", "pos", "agent", "app"],
  // An app's method (`<plugin id>:<provider id>`) is named by its provider.
  paymentMethod: ["cod", "stripe", "gift_card", "other"],
  paymentKind: ["payment", "refund"],
  paymentStatus: ["pending", "confirmed", "succeeded", "failed", "refunded", "cancelled", "other"],
  codState: ["collected", "with_courier", "not_shipped", "returned_to_sender", "refunded"],
  giftCardMeasure: [
    "outstanding_balance",
    "unusable_balance",
    "issued_purchase",
    "issued_manual",
    "issued_refund",
    "redeemed",
  ],
  discountMethod: ["code", "automatic", "manual"],
};
