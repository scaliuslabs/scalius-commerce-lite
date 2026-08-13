export const ORDER_CSV_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

const UTF8_BOM = "\uFEFF";

export interface OrderCsvSummary {
  id: string;
  customerName: string;
  customerPhone: string;
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

export interface OrderCsvArtifactBuilder {
  append(order: OrderCsvSummary): boolean;
  finish(): OrderCsvArtifact;
}

export function spreadsheetSafeCsvCell(value: unknown): string {
  const normalized = value == null
    ? ""
    : value instanceof Date
      ? value.toISOString()
      : String(value);
  const safe = /^[\t\r\n ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  return `"${safe.replaceAll('"', '""')}"`;
}

function row(values: unknown[]): string {
  return values.map(spreadsheetSafeCsvCell).join(",");
}

function createCsvArtifactBuilder(
  headers: string[],
  values: (order: OrderCsvSummary) => unknown[],
  maxBytes: number,
): OrderCsvArtifactBuilder {
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
      const chunk = `\n${row(values(order))}`;
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

export function createOrdersCsvArtifactBuilder(
  maxBytes = ORDER_CSV_ARTIFACT_MAX_BYTES,
): OrderCsvArtifactBuilder {
  return createCsvArtifactBuilder([
    "Order ID", "Customer Name", "Phone", "Email", "City", "Zone", "Area",
    "Status", "Payment Status", "Payment Method", "Payment Recovery",
    "Recovery Gateway", "Recovery Status", "Recovery Attempts", "Shipment Recovery",
    "Shipment Recovery Status", "Fulfillment Status", "Total Amount", "Discount",
    "Items", "Created At",
  ], (order) => [
    order.id, order.customerName, order.customerPhone, order.customerEmail,
    order.cityName ?? order.city, order.zoneName ?? order.zone, order.areaName ?? order.area,
    order.status, order.paymentStatus, order.paymentMethod,
    order.paymentRecovery.state === "none" ? "" : order.paymentRecovery.label,
    order.paymentRecovery.gateway, order.paymentRecovery.status, order.paymentRecovery.attempts,
    order.shipmentRecovery.state === "none" ? "" : order.shipmentRecovery.label,
    order.shipmentRecovery.status, order.fulfillmentStatus, order.totalAmount,
    order.discountAmount, order.itemCount, order.createdAt,
  ], maxBytes);
}

export function createPaymentRecoveryCsvArtifactBuilder(
  maxBytes = ORDER_CSV_ARTIFACT_MAX_BYTES,
): OrderCsvArtifactBuilder {
  return createCsvArtifactBuilder([
    "Order ID", "Customer Name", "Phone", "Email", "Order Status", "Payment Status",
    "Payment Method", "Recovery State", "Recovery Label", "Recovery Gateway",
    "Recovery Payment Type", "Recovery Attempt Status", "Recovery Attempts",
    "Active Processing", "Stale Processing", "Recovery Updated At", "Total Amount", "Created At",
  ], (order) => [
    order.id, order.customerName, order.customerPhone, order.customerEmail, order.status,
    order.paymentStatus, order.paymentMethod, order.paymentRecovery.state,
    order.paymentRecovery.label, order.paymentRecovery.gateway, order.paymentRecovery.paymentType,
    order.paymentRecovery.status, order.paymentRecovery.attempts,
    order.paymentRecovery.activeProcessing ? "yes" : "no",
    order.paymentRecovery.staleProcessing ? "yes" : "no", order.paymentRecovery.updatedAt,
    order.totalAmount, order.createdAt,
  ], maxBytes);
}
