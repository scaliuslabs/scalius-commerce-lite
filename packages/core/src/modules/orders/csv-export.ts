import { usesDeliveryHierarchy } from "@scalius/shared/address";
import { COMMERCE_UTC_OFFSET_SECONDS } from "@scalius/shared/commerce-time";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatMoney } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import {
  isOrderChannelSourcePreset,
  type OrderChannel,
  type OrderChannelSourcePreset,
} from "@scalius/shared/order-channel";
import { spreadsheetSafeCsvCell } from "@scalius/shared/spreadsheet-csv";
import { formatOrderLinePropertiesText, parseOrderLineProperties } from "./line-presentation";

export const ORDER_CSV_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

const UTF8_BOM = "\uFEFF";

/** A payment-recovery queue row. */
export interface OrderCsvSummary {
  id: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  status: string;
  paymentStatus: string | null;
  paymentMethod: string | null;
  fulfillmentStatus: string | null;
  totalAmount: number;
  discountAmount: number;
  itemCount: number;
  createdAt: unknown;
  paymentRecovery: {
    state: string;
    label: string;
    gateway: string | null;
    paymentType: string | null;
    status: string | null;
    attempts: number;
    activeProcessing: boolean;
    staleProcessing: boolean;
    updatedAt: unknown;
  };
  shipmentRecovery: { state: string; label: string; status: string | null };
}

export interface OrderCsvArtifact {
  chunks: readonly string[];
  byteLength: number;
  rowCount: number;
  truncatedByBytes: boolean;
}

export interface OrderCsvArtifactBuilder<T = OrderCsvSummary> {
  /** Adds one order (one or more CSV rows); false once the byte limit is reached. */
  append(order: T): boolean;
  finish(): OrderCsvArtifact;
}

function row(values: unknown[]): string {
  return values.map(spreadsheetSafeCsvCell).join(",");
}

/**
 * A byte-capped, spreadsheet-safe CSV: UTF-8 BOM, every cell quoted and
 * formula-escaped. Shared by the order, payment-recovery and report exports.
 */
export function createCsvArtifactBuilder<T>(
  headers: string[],
  values: (order: T) => unknown[][],
  maxBytes: number,
): OrderCsvArtifactBuilder<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("CSV artifact byte limit must be a positive safe integer.");
  }

  const encoder = new TextEncoder();
  const header = `${UTF8_BOM}${row(headers)}`;
  const headerBytes = encoder.encode(header).byteLength;
  if (headerBytes > maxBytes) {
    throw new RangeError("CSV artifact byte limit cannot contain its header.");
  }

  const chunks: string[] = [header];
  let byteLength = headerBytes;
  let rowCount = 0;
  let truncatedByBytes = false;

  return {
    append(order) {
      if (truncatedByBytes) return false;
      const chunk = values(order).map((cells) => `\n${row(cells)}`).join("");
      const chunkBytes = encoder.encode(chunk).byteLength;
      if (byteLength + chunkBytes > maxBytes) {
        truncatedByBytes = true;
        return false;
      }
      chunks.push(chunk);
      byteLength += chunkBytes;
      rowCount += 1;
      return true;
    },
    finish() {
      return {
        chunks: [...chunks],
        byteLength,
        rowCount,
        truncatedByBytes,
      };
    },
  };
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  confirmed: "Confirmed",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  returned: "Returned",
  refunded: "Refunded",
  incomplete: "Payment not finished",
};
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  failed: "Failed",
};
const FULFILLMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Unfulfilled",
  partial: "Partly fulfilled",
  complete: "Fulfilled",
};
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cod: "Cash on delivery",
  stripe: "Card (Stripe)",
  sslcommerz: "SSLCommerz",
};
const CHANNEL_LABELS: Record<OrderChannel, string> = {
  online_store: "Online store",
  admin: "Dashboard",
  pos: "POS",
  agent: "AI agent",
  app: "App",
};
const CHANNEL_SOURCE_LABELS: Record<OrderChannelSourcePreset, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  phone: "Phone",
  walk_in: "Walk-in",
};
const COD_STATUS_LABELS: Record<string, string> = {
  pending: "To collect",
  collected: "Collected",
  failed: "Delivery failed",
  returned: "Returned to sender",
};

function label(labels: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "";
  return labels[value] ?? value.replace(/_/g, " ");
}

/** "2026-09-24 05:28" in store time (Asia/Dhaka), so orders land on the right day. */
export function formatCommerceDateTime(value: unknown): string {
  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value < 10_000_000_000 ? value * 1000 : value)
      : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() + COMMERCE_UTC_OFFSET_SECONDS * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

export interface OrderCsvLine {
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Buyer inputs as "Engraving: Anika (+৳200)", from `formatOrderCsvLineProperties`. */
  properties?: string[];
}

/** The frozen `order_items.properties` snapshot as export text (never SMS). */
export function formatOrderCsvLineProperties(
  stored: string | null,
  currencyCode: string,
  decimalPlaces: number,
): string[] {
  return formatOrderLinePropertiesText(
    parseOrderLineProperties(stored),
    (priceMinor) => formatMoney(fromMinor(priceMinor, decimalPlaces), { code: currencyCode }),
  );
}

/** One order in the export: the list row plus its address, lines and delivery facts. */
export interface OrderCsvRow {
  id: string;
  orderNumber: number | null;
  createdAt: unknown;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  /** Null when nothing ships (pickup, service-only or digital orders). */
  shippingAddress: string | null;
  /** The rest of the address snapshot (MARKETS-DESIGN D7). */
  shippingAddressLine2?: string | null;
  shippingCountryCode?: string | null;
  shippingDependentLocality?: string | null;
  shippingLocality?: string | null;
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  /** False for pickup and orders with nothing physical; absent on older rows (ships). */
  requiresShipping?: boolean;
  /** The one delivery method's kind; null when the order needs none. */
  shippingMethodKind?: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  status: string;
  paymentStatus: string | null;
  paymentMethod: string | null;
  fulfillmentStatus: string | null;
  subtotalAmount: number;
  shippingCharge: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  refundedAmount: number;
  balanceDue: number;
  codStatus: string | null;
  courierName: string | null;
  trackingId: string | null;
  notes: string | null;
  /** Where the order came from, and the merchant's source label within it. */
  channel: OrderChannel;
  channelSource: string | null;
  lines: OrderCsvLine[];
}

export type OrderCsvFormat = "summary" | "items";

function describeLine(line: OrderCsvLine): string {
  const name = [line.productName, line.variantLabel].filter(Boolean).join(" (") + (line.variantLabel ? ")" : "");
  const properties = line.properties?.length ? ` — ${line.properties.join(", ")}` : "";
  return `${line.quantity} × ${name || "Item"}${properties}`;
}

/** "Delivery", "Pickup", or "No delivery" for a cart with nothing physical. */
function deliveryMethodLabel(order: OrderCsvRow): string {
  if (order.shippingMethodKind === "pickup") return "Pickup";
  if (order.requiresShipping === false && !order.shippingMethodKind) return "No delivery";
  return "Delivery";
}

function orderColumns(order: OrderCsvRow): unknown[] {
  // Pickup and no-ship orders have no address; never print a stale one.
  const ships = order.requiresShipping !== false;
  // Bangladesh fills Area, Thana and City from its delivery locations; another
  // country its second line, dependent locality and locality (the region,
  // postal code and country are the last three columns).
  const bangladesh = usesDeliveryHierarchy(order.shippingCountryCode);
  return [
    formatOrderNumber(order.orderNumber, order.id),
    formatCommerceDateTime(order.createdAt),
    order.customerName,
    order.customerPhone ? formatPhoneForProvider(order.customerPhone) : "",
    order.customerEmail,
    ships ? [order.shippingAddress, order.shippingAddressLine2].filter(Boolean).join(", ") : "",
    ships ? (bangladesh ? order.areaName : order.shippingDependentLocality) : "",
    ships && bangladesh ? order.zoneName : "",
    ships ? (bangladesh ? order.cityName : order.shippingLocality) : "",
    deliveryMethodLabel(order),
    label(ORDER_STATUS_LABELS, order.status),
    paymentLabel(order),
    label(PAYMENT_METHOD_LABELS, order.paymentMethod),
    label(FULFILLMENT_STATUS_LABELS, order.fulfillmentStatus),
    order.courierName,
    order.trackingId,
    CHANNEL_LABELS[order.channel],
    channelSourceLabel(order.channelSource),
  ];
}

/** A preset reads as its name ("Walk-in"); the merchant's own source as they saved it. */
function channelSourceLabel(source: string | null): string {
  if (!source) return "";
  return isOrderChannelSourcePreset(source) ? CHANNEL_SOURCE_LABELS[source] : source;
}

/**
 * The order page's payment wording: a cancelled or returned order that was
 * never paid owes nothing, rather than reading "Unpaid".
 */
function paymentLabel(order: OrderCsvRow): string {
  if (["cancelled", "returned"].includes(order.status) && (order.paymentStatus ?? "unpaid") === "unpaid") {
    return "Nothing due";
  }
  return label(PAYMENT_STATUS_LABELS, order.paymentStatus);
}

/** What the customer paid before any refund (cash handed to the rider, or online). */
function amountReceived(order: OrderCsvRow): number {
  return Math.round((order.paidAmount + order.refundedAmount) * 100) / 100;
}

const ORDER_HEADERS = [
  "Order", "Date", "Customer", "Phone", "Email", "Address", "Area", "Thana", "City",
  "Delivery method", "Status", "Payment", "Payment method", "Delivery", "Courier", "Tracking",
  "Channel", "Source",
];

/**
 * The merchant's working export: store-time dates, readable statuses, the
 * delivery address, items, delivery charge, courier/tracking and cash on
 * delivery, either one row per order or one row per item (ORD-11).
 */
export function createOrdersCsvArtifactBuilder(
  format: OrderCsvFormat = "summary",
  maxBytes = ORDER_CSV_ARTIFACT_MAX_BYTES,
) {
  if (format === "items") {
    return createCsvArtifactBuilder<OrderCsvRow>([
      ...ORDER_HEADERS, "Product", "Variant", "Customisation", "Quantity", "Unit price", "Line total",
      "Delivery charge", "Discount", "Order total", "Paid", "Refunded", "Cash to collect",
      ...ADDRESS_TAIL_HEADERS,
    ], (order) => (order.lines.length > 0 ? order.lines : [null]).map((line, index) => [
      ...orderColumns(order),
      line?.productName ?? "",
      line?.variantLabel ?? "",
      line?.properties?.join("; ") ?? "",
      line?.quantity ?? "",
      line?.unitPrice ?? "",
      line?.lineTotal ?? "",
      // Order-level money only on the first line so column sums stay right.
      index === 0 ? order.shippingCharge : "",
      index === 0 ? order.discountAmount : "",
      index === 0 ? order.totalAmount : "",
      index === 0 ? amountReceived(order) : "",
      index === 0 ? order.refundedAmount : "",
      index === 0 ? cashToCollect(order) : "",
      ...addressTail(order),
    ]), maxBytes);
  }
  return createCsvArtifactBuilder<OrderCsvRow>([
    ...ORDER_HEADERS, "Items", "Item count", "Subtotal", "Delivery charge", "Discount",
    "Total", "Paid", "Refunded", "Cash to collect", "Cash on delivery", "Note",
    ...ADDRESS_TAIL_HEADERS,
  ], (order) => [[
    ...orderColumns(order),
    order.lines.map(describeLine).join("; "),
    order.lines.reduce((sum, line) => sum + line.quantity, 0),
    order.subtotalAmount,
    order.shippingCharge,
    order.discountAmount,
    order.totalAmount,
    amountReceived(order),
    order.refundedAmount,
    cashToCollect(order),
    order.paymentMethod === "cod" && !["cancelled", "returned"].includes(order.status)
      ? label(COD_STATUS_LABELS, order.codStatus)
      : "",
    order.notes,
    ...addressTail(order),
  ]], maxBytes);
}

/** Region, postal code and country: appended last, so the earlier columns keep their places. */
const ADDRESS_TAIL_HEADERS = ["Region", "Postal code", "Country"];

function addressTail(order: OrderCsvRow): unknown[] {
  if (order.requiresShipping === false || !order.shippingAddress) return ["", "", ""];
  return [order.shippingAdminArea ?? "", order.shippingPostalCode ?? "", order.shippingCountryCode ?? "BD"];
}

function cashToCollect(order: OrderCsvRow): number | string {
  if (order.paymentMethod !== "cod") return "";
  return ["cancelled", "returned", "refunded"].includes(order.status) ? 0 : order.balanceDue;
}

export function createPaymentRecoveryCsvArtifactBuilder(
  maxBytes = ORDER_CSV_ARTIFACT_MAX_BYTES,
): OrderCsvArtifactBuilder {
  return createCsvArtifactBuilder<OrderCsvSummary>([
    "Order ID", "Customer Name", "Phone", "Email", "Order Status", "Payment Status",
    "Payment Method", "Recovery State", "Recovery Label", "Recovery Gateway",
    "Recovery Payment Type", "Recovery Attempt Status", "Recovery Attempts",
    "Active Processing", "Stale Processing", "Recovery Updated At", "Total Amount", "Created At",
  ], (order) => [[
    order.id, order.customerName, order.customerPhone, order.customerEmail, order.status,
    order.paymentStatus, order.paymentMethod, order.paymentRecovery.state,
    order.paymentRecovery.label, order.paymentRecovery.gateway, order.paymentRecovery.paymentType,
    order.paymentRecovery.status, order.paymentRecovery.attempts,
    order.paymentRecovery.activeProcessing ? "yes" : "no",
    order.paymentRecovery.staleProcessing ? "yes" : "no", order.paymentRecovery.updatedAt,
    order.totalAmount, order.createdAt,
  ]], maxBytes);
}
