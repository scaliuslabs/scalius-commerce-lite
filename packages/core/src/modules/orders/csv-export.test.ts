import { describe, expect, it } from "vitest";
import {
  createOrdersCsvArtifactBuilder,
  createPaymentRecoveryCsvArtifactBuilder,
  ORDER_CSV_ARTIFACT_MAX_BYTES,
  spreadsheetSafeCsvCell,
  type OrderCsvRow,
  type OrderCsvSummary,
} from "./csv-export";

const recoveryRow: OrderCsvSummary = {
  id: "ord_1", customerName: "Buyer", customerPhone: "01700", customerEmail: null,
  city: "Dhaka", zone: null, area: null, cityName: null, zoneName: null, areaName: null,
  status: "confirmed", paymentStatus: "paid", paymentMethod: "cod",
  fulfillmentStatus: "pending", totalAmount: 100, discountAmount: 0, itemCount: 1,
  createdAt: 1_700_000_000,
  paymentRecovery: { state: "none", label: "", gateway: null, paymentType: null,
    status: null, attempts: 0, activeProcessing: false, staleProcessing: false, updatedAt: null },
  shipmentRecovery: { state: "none", label: "", status: null },
};

const order: OrderCsvRow = {
  id: "ord_1", orderNumber: 1042, createdAt: 1_790_292_481, customerName: "Buyer",
  customerPhone: "+8801712345605", customerEmail: null, shippingAddress: "House 1, Road 2",
  cityName: "Dhaka", zoneName: "Gulshan", areaName: null, status: "shipped",
  paymentStatus: "partially_refunded", paymentMethod: "cod", fulfillmentStatus: "complete",
  subtotalAmount: 2400, shippingCharge: 80, discountAmount: 0, totalAmount: 2480, paidAmount: 1980,
  refundedAmount: 500, balanceDue: 0, codStatus: "collected", courierName: "Steadfast", trackingId: "SF123",
  notes: null,
  lines: [
    { productName: "Kurta", variantLabel: "M", quantity: 2, unitPrice: 800, lineTotal: 1600 },
    { productName: "Panjabi", variantLabel: null, quantity: 1, unitPrice: 800, lineTotal: 800 },
  ],
};

describe("order CSV artifacts", () => {
  it.each(["=1+1", "+cmd", "-1", "@SUM(A1)", "  =A1"])(
    "neutralizes spreadsheet formula cell %s",
    (value) => expect(spreadsheetSafeCsvCell(value)).toBe(`"'${value}"`),
  );

  it("keeps an international phone number as data", () => {
    expect(spreadsheetSafeCsvCell("+8801712345605")).toBe('"+8801712345605"');
  });

  it("writes store-time dates, readable statuses, the local phone, address, items and courier", () => {
    const builder = createOrdersCsvArtifactBuilder("summary");
    expect(builder.append({ ...order, customerName: 'Buyer, "One"' })).toBe(true);
    const csv = builder.finish().chunks.join("");
    expect(csv).toContain('"Buyer, ""One"""');
    expect(csv).toContain('"#1042","2026-09-25 05:28"');
    expect(csv).toContain('"01712345605"');
    expect(csv).toContain('"Shipped","Partially refunded","Cash on delivery","Fulfilled","Steadfast","SF123"');
    expect(csv).toContain('"2 × Kurta (M); 1 × Panjabi"');
    expect(csv).toContain('"Collected"');
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).not.toContain("undefined");
    expect(csv).not.toMatch(/Recovery/);
  });

  it("writes one row per item with order money only on the first line", () => {
    const builder = createOrdersCsvArtifactBuilder("items");
    builder.append(order);
    const rows = builder.finish().chunks.join("").split("\n");
    expect(rows).toHaveLength(3);
    // Paid is what the rider collected; the refund is its own column.
    expect(rows[1]).toContain('"Kurta","M","2","800","1600","80","0","2480","2480","500","0"');
    expect(rows[2]).toContain('"Panjabi","","1","800","800","","","","","",""');
  });

  it("says nothing is due on a returned order that was never paid", () => {
    const builder = createOrdersCsvArtifactBuilder("summary");
    builder.append({ ...order, status: "returned", paymentStatus: "unpaid", paidAmount: 0, refundedAmount: 0, balanceDue: 2480 });
    const csv = builder.finish().chunks.join("");
    expect(csv).toContain('"Returned","Nothing due","Cash on delivery"');
  });

  it.each([
    ["orders", () => createOrdersCsvArtifactBuilder("summary"), (limit: number) => createOrdersCsvArtifactBuilder("summary", limit), order],
    ["payment recovery", () => createPaymentRecoveryCsvArtifactBuilder(), (limit: number) => createPaymentRecoveryCsvArtifactBuilder(limit), recoveryRow],
  ] as const)("stops the %s artifact before a complete Unicode row exceeds its byte limit", (_, create, createLimited, row) => {
    type Artifact = { chunks: readonly string[]; byteLength: number; rowCount: number; truncatedByBytes: boolean };
    const probe = create() as { append(value: typeof row): boolean; finish(): Artifact };
    expect(probe.append({ ...row, customerName: "Buyer 😀" })).toBe(true);
    const probeArtifact = probe.finish();
    const headerBytes = new TextEncoder().encode(probeArtifact.chunks[0]).byteLength;
    const rowBytes = new TextEncoder().encode(probeArtifact.chunks[1]).byteLength;

    const exactBuilder = createLimited(headerBytes + rowBytes) as typeof probe;
    expect(exactBuilder.append({ ...row, customerName: "Buyer 😀" })).toBe(true);
    expect(exactBuilder.append({ ...row, id: "ord_2", customerName: "😀".repeat(32) })).toBe(false);
    const artifact = exactBuilder.finish();

    expect(artifact.byteLength).toBe(headerBytes + rowBytes);
    expect(artifact.rowCount).toBe(1);
    expect(artifact.truncatedByBytes).toBe(true);
  });

  it("enforces the fixed 16 MiB ceiling against an unconstrained persisted Unicode field", () => {
    expect(ORDER_CSV_ARTIFACT_MAX_BYTES).toBe(16_777_216);
    const builder = createOrdersCsvArtifactBuilder();
    expect(builder.append({
      ...order,
      customerName: "😀".repeat(Math.ceil(ORDER_CSV_ARTIFACT_MAX_BYTES / 4)),
    })).toBe(false);
    const artifact = builder.finish();
    expect(artifact.rowCount).toBe(0);
    expect(artifact.truncatedByBytes).toBe(true);
    expect(artifact.byteLength).toBeLessThanOrEqual(ORDER_CSV_ARTIFACT_MAX_BYTES);
  });
});
