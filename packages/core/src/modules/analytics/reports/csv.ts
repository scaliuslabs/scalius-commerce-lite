// Report CSV exports: English headings with the currency on money columns,
// decimal major units, readable enum words, and the shared spreadsheet-safe
// byte-capped artifact builder used by the order exports.
import { fromMinor } from "@scalius/shared/money";
import type {
  AnalyticsColumn,
  AnalyticsEnumVocabulary,
  AnalyticsReportDefinition,
} from "@scalius/shared/analytics-reports";
import { createCsvArtifactBuilder, type OrderCsvArtifact } from "../../orders";
import type { ReportCell, ReportRow } from "./engine";

export const REPORT_CSV_MAX_BYTES = 16 * 1024 * 1024;

/** English column headings (the dashboard words them from its own catalogs). */
export const REPORT_COLUMN_LABELS_EN: Record<string, string> = {
  period: "Period",
  product: "Product",
  variant: "Variant",
  sku: "SKU",
  category: "Category",
  brand: "Brand",
  collection: "Collection",
  discount: "Discount",
  code: "Code",
  method: "Method",
  channel: "Channel",
  source: "Source",
  payment_method: "Payment method",
  city: "City",
  delivery_zone: "Delivery zone",
  location: "Location",
  customer: "Customer",
  phone: "Phone",
  orders: "Orders",
  net_items_sold: "Net items sold",
  gross_sales: "Gross sales",
  discounts: "Discounts",
  returns: "Returns",
  net_sales: "Net sales",
  shipping: "Shipping",
  taxes: "Taxes",
  total_sales: "Total sales",
  average_order_value: "Average order value",
  discount_amount: "Discount amount",
  first_order: "First order",
  last_order: "Last order",
  customers: "Customers",
  new_customers: "New customers",
  returning_customers: "Returning customers",
  new_customer_sales: "Sales from new customers",
  skus: "SKUs in stock",
  units_on_hand: "Units on hand",
  retail_value: "Retail value",
  available: "Available",
  threshold: "Alert level",
  units_sold_30_days: "Units sold (30 days)",
  days_of_cover: "Days of cover",
  units_sold: "Units sold",
  sell_through_rate: "Sell-through %",
  average_daily_sales: "Units sold per day",
  kind: "Kind",
  status: "Status",
  transactions: "Transactions",
  amount: "Amount",
  refunds: "Refunds",
  refunded: "Refunded",
  pending: "Pending",
  failed: "Failed",
  cod_state: "Cash on delivery",
  order_value: "Order value",
  collected: "Collected",
  outstanding: "Outstanding",
  measure: "Measure",
  cards: "Cards",
  tax_class: "Tax class",
  taxable_sales: "Sales",
  tax_collected: "Tax collected",
  courier: "Courier",
  parcels: "Parcels",
  delivered: "Delivered",
  returned: "Returned",
  in_transit: "In transit",
  delivery_rate: "Delivery rate %",
  return_rate: "Return rate %",
  average_days_to_dispatch: "Days to dispatch",
  average_days_to_collect: "Days to collect cash",
  abandoned_checkouts: "Abandoned checkouts",
  reachable: "With a phone",
  recovered: "Recovered",
  recovery_rate: "Recovery rate %",
  recovered_sales: "Recovered sales",
  costed_items: "Items with a cost",
  cost_of_goods: "Cost of goods",
  gross_profit: "Gross profit",
  gross_margin: "Gross margin %",
  cost_coverage: "Cost coverage %",
};

const ENUM_LABELS_EN: Record<AnalyticsEnumVocabulary, Record<string, string>> = {
  channel: { online_store: "Online store", admin: "Dashboard", pos: "Point of sale", agent: "AI agent", app: "App" },
  paymentMethod: { cod: "Cash on delivery", stripe: "Card (Stripe)", gift_card: "Gift card", other: "Other" },
  paymentKind: { payment: "Payment", refund: "Refund" },
  paymentStatus: {
    pending: "Pending",
    confirmed: "Confirmed",
    succeeded: "Succeeded",
    failed: "Failed",
    refunded: "Refunded",
    cancelled: "Cancelled",
  },
  codState: {
    collected: "Collected",
    with_courier: "With courier",
    not_shipped: "Not shipped yet",
    returned_to_sender: "Returned to sender",
    refunded: "Refunded",
  },
  giftCardMeasure: {
    outstanding_balance: "Outstanding balance (liability)",
    unusable_balance: "Balance on disabled or expired cards",
    issued_purchase: "Issued: sold",
    issued_manual: "Issued: by staff",
    issued_refund: "Issued: as refunds",
    redeemed: "Redeemed",
  },
  discountMethod: { code: "Code", automatic: "Automatic", manual: "Manual or app" },
};

/** Placeholder keys reports use for rows without a name. */
const TOKEN_LABELS_EN: Record<string, string> = {
  "": "(none)",
  __no_delivery: "No delivery",
  __pickup: "Pickup",
  __unknown: "Not recorded",
  __everywhere_else: "Everywhere else",
  __shipping: "Shipping",
};

/** A payment method the report has no words for (an app's): its provider's name. */
type PaymentMethodName = ((id: string) => string) | undefined;

function cellText(column: AnalyticsColumn, value: ReportCell, decimalPlaces: number, paymentMethodName?: PaymentMethodName): string | number {
  if (value === null) return "";
  switch (column.type) {
    case "money":
      return fromMinor(Number(value), decimalPlaces).toFixed(decimalPlaces);
    case "percent":
    case "days":
    case "number":
      return Math.round(Number(value) * 100) / 100;
    case "count":
      return Number(value);
    case "enum": {
      const known = column.enum && ENUM_LABELS_EN[column.enum][String(value)];
      if (known) return known;
      return column.enum === "paymentMethod" && paymentMethodName ? paymentMethodName(String(value)) : String(value);
    }
    default:
      return TOKEN_LABELS_EN[String(value)] ?? String(value);
  }
}

export function reportCsvHeaders(report: AnalyticsReportDefinition, currencyCode: string): string[] {
  return report.columns.map((column) => {
    const label = REPORT_COLUMN_LABELS_EN[column.key] ?? column.key;
    return column.type === "money" ? `${label} (${currencyCode})` : label;
  });
}

export interface ReportCsvBuilder {
  append(row: ReportRow): boolean;
  appendTotals(totals: Record<string, ReportCell>): boolean;
  finish(): OrderCsvArtifact;
}

/** Rows then one "Total" row (blank where a column doesn't add up). */
export function createReportCsvBuilder(
  report: AnalyticsReportDefinition,
  currency: { code: string; decimalPlaces: number },
  maxBytes = REPORT_CSV_MAX_BYTES,
  paymentMethodName?: PaymentMethodName,
): ReportCsvBuilder {
  type Line = { values: Record<string, ReportCell>; total: boolean };
  const builder = createCsvArtifactBuilder<Line>(reportCsvHeaders(report, currency.code), (line) => [
    report.columns.map((column, index) => {
      if (line.total && index === 0) return "Total";
      return cellText(column, line.values[column.key] ?? null, currency.decimalPlaces, paymentMethodName);
    }),
  ], maxBytes);
  return {
    append: (row) => builder.append({ values: row.values, total: false }),
    appendTotals: (totals) => builder.append({ values: totals, total: true }),
    finish: () => builder.finish(),
  };
}
