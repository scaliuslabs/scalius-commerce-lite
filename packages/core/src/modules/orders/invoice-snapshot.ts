import {
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import type { BusinessInfo } from "../settings/business-settings.service";

export const INVOICE_RENDER_VERSION = "invoice-v1" as const;

export interface InvoiceOrderItemSnapshot {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  variantLabel: string | null;
  fulfillmentStatus: string | null;
  unitPriceMinor: number | null;
  lineSubtotalMinor: number | null;
  discountAmountMinor: number | null;
  taxableAmountMinor: number | null;
  taxAmountMinor: number | null;
}

export interface InvoiceOrderSnapshot {
  id: string;
  version: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  customerId: string | null;
  shippingAddress: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  currencyCode: string | null;
  currencyDecimalPlaces: number | null;
  subtotalAmountMinor: number | null;
  shippingAmountMinor: number | null;
  shippingMethodId: string | null;
  shippingMethodName: string | null;
  shippingMethodDescription: string | null;
  shippingMethodBaseAmountMinor: number | null;
  shippingFeeWaived: boolean | null;
  discountAmountMinor: number | null;
  taxAmountMinor: number;
  totalAmountMinor: number | null;
  taxLabel: string | null;
  pricesIncludeTax: boolean;
  status: string;
  paymentStatus: string | null;
  paymentMethod: string | null;
  fulfillmentStatus: string | null;
  paidAmount: number | null;
  balanceDue: number | null;
  createdAt: string | number;
  updatedAt: string | number;
  items: InvoiceOrderItemSnapshot[];
}

export interface StoredInvoiceSnapshot {
  schemaVersion: 1;
  renderVersion: typeof INVOICE_RENDER_VERSION;
  invoiceNumber: number;
  formattedNumber: string;
  prefix: string;
  issuedAt: number;
  businessInfo: BusinessInfo;
  order: InvoiceOrderSnapshot;
}

export interface InvoiceDocument {
  status: "draft" | "issued";
  order: InvoiceOrderSnapshot;
  invoiceNumber: string | null;
  invoiceNum: number | null;
  businessInfo: BusinessInfo;
  issuedAt: number | null;
  contentHash: string | null;
  renderVersion: typeof INVOICE_RENDER_VERSION;
  orderVersion: number;
}

export function formatInvoiceNumber(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(5, "0")}`;
}

export function stableInvoiceStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableInvoiceStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${stableInvoiceStringify(record[key])}`,
    )
    .join(",")}}`;
}

export async function hashInvoiceContent(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function timestamp(value: unknown): string | number {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "string") return value;
  throw new ServiceUnavailableError(
    "Order timestamp is unavailable for invoice rendering.",
  );
}

export function snapshotInvoiceOrder(
  order: InvoiceOrderSnapshot,
): InvoiceOrderSnapshot {
  return {
    id: order.id,
    version: order.version,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    customerId: order.customerId,
    shippingAddress: order.shippingAddress,
    city: order.city,
    zone: order.zone,
    area: order.area,
    cityName: order.cityName,
    zoneName: order.zoneName,
    areaName: order.areaName,
    totalAmount: order.totalAmount,
    shippingCharge: order.shippingCharge,
    discountAmount: order.discountAmount,
    currencyCode: order.currencyCode,
    currencyDecimalPlaces: order.currencyDecimalPlaces,
    subtotalAmountMinor: order.subtotalAmountMinor,
    shippingAmountMinor: order.shippingAmountMinor,
    shippingMethodId: order.shippingMethodId ?? null,
    shippingMethodName: order.shippingMethodName ?? null,
    shippingMethodDescription: order.shippingMethodDescription ?? null,
    shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor ?? null,
    shippingFeeWaived: order.shippingFeeWaived ?? null,
    discountAmountMinor: order.discountAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
    taxLabel: order.taxLabel,
    pricesIncludeTax: order.pricesIncludeTax,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    fulfillmentStatus: order.fulfillmentStatus,
    paidAmount: order.paidAmount,
    balanceDue: order.balanceDue,
    createdAt: timestamp(order.createdAt),
    updatedAt: timestamp(order.updatedAt),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      productName: item.productName,
      variantLabel: item.variantLabel,
      fulfillmentStatus: item.fulfillmentStatus ?? null,
      unitPriceMinor: item.unitPriceMinor ?? null,
      lineSubtotalMinor: item.lineSubtotalMinor ?? null,
      discountAmountMinor: item.discountAmountMinor ?? null,
      taxableAmountMinor: item.taxableAmountMinor ?? null,
      taxAmountMinor: item.taxAmountMinor ?? null,
    })),
  };
}

export function validateInvoiceBusinessInfo(
  businessInfo: BusinessInfo,
): BusinessInfo {
  if (!businessInfo.companyName.trim() && !businessInfo.legalName.trim()) {
    throw new ValidationError(
      "Add a company or legal name in Business settings before issuing an invoice.",
    );
  }
  const prefix = businessInfo.invoicePrefix.trim() || "INV";
  if (prefix.length > 40) {
    throw new ValidationError("Invoice prefix must be 40 characters or fewer.");
  }
  return { ...businessInfo, invoicePrefix: prefix };
}

export function invoiceSnapshotToDocument(
  snapshot: StoredInvoiceSnapshot,
  contentHash: string,
): InvoiceDocument {
  const order = snapshotInvoiceOrder(snapshot.order);
  return {
    status: "issued",
    order,
    invoiceNumber: snapshot.formattedNumber,
    invoiceNum: snapshot.invoiceNumber,
    businessInfo: snapshot.businessInfo,
    issuedAt: snapshot.issuedAt,
    contentHash,
    renderVersion: snapshot.renderVersion,
    orderVersion: order.version,
  };
}

export async function parseStoredInvoice(row: {
  snapshot: string;
  contentHash: string;
}): Promise<InvoiceDocument> {
  const actualHash = await hashInvoiceContent(row.snapshot);
  if (actualHash !== row.contentHash) {
    throw new ServiceUnavailableError(
      "Issued invoice snapshot failed its integrity check.",
    );
  }
  try {
    return invoiceSnapshotToDocument(
      JSON.parse(row.snapshot) as StoredInvoiceSnapshot,
      row.contentHash,
    );
  } catch {
    throw new ServiceUnavailableError("Issued invoice snapshot is unreadable.");
  }
}
