import { describe, expect, it } from "vitest";
import {
  createOrdersCsvArtifactBuilder,
  createPaymentRecoveryCsvArtifactBuilder,
  ORDER_CSV_ARTIFACT_MAX_BYTES,
  spreadsheetSafeCsvCell,
  type OrderCsvSummary,
} from "./order-csv-export";

const order: OrderCsvSummary = {
  id: "ord_1", customerName: "Buyer", customerPhone: "01700", customerEmail: null,
  city: "Dhaka", zone: null, area: null, cityName: null, zoneName: null, areaName: null,
  status: "confirmed", paymentStatus: "paid", paymentMethod: "cod",
  fulfillmentStatus: "pending", totalAmount: 100, discountAmount: 0, itemCount: 1,
  createdAt: 1_700_000_000,
  paymentRecovery: { state: "none", label: "", gateway: null, paymentType: null,
    status: null, attempts: 0, activeProcessing: false, staleProcessing: false, updatedAt: null },
  shipmentRecovery: { state: "none", label: "", status: null },
};

describe("order CSV artifacts", () => {
  it.each(["=1+1", "+cmd", "-1", "@SUM(A1)", "  =A1"])(
    "neutralizes spreadsheet formula cell %s",
    (value) => expect(spreadsheetSafeCsvCell(value)).toBe(`"'${value}"`),
  );

  it("quotes embedded separators and does not emit recovery placeholders", () => {
    const builder = createOrdersCsvArtifactBuilder();
    expect(builder.append({ ...order, customerName: 'Buyer, "One"' })).toBe(true);
    const artifact = builder.finish();
    const csv = artifact.chunks.join("");
    expect(csv).toContain('"Buyer, ""One"""');
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).not.toContain("undefined");
    expect(artifact.byteLength).toBe(new TextEncoder().encode(csv).byteLength);
    expect(artifact.byteLength).toBeLessThanOrEqual(ORDER_CSV_ARTIFACT_MAX_BYTES);
  });

  it.each([
    ["orders", createOrdersCsvArtifactBuilder],
    ["payment recovery", createPaymentRecoveryCsvArtifactBuilder],
  ] as const)("stops the %s artifact before a complete Unicode row exceeds its byte limit", (_, createBuilder) => {
    const probe = createBuilder();
    expect(probe.append({ ...order, customerName: "Buyer 😀" })).toBe(true);
    const probeArtifact = probe.finish();
    const headerBytes = new TextEncoder().encode(probeArtifact.chunks[0]).byteLength;
    const rowBytes = new TextEncoder().encode(probeArtifact.chunks[1]).byteLength;

    const exactBuilder = createBuilder(headerBytes + rowBytes);
    expect(exactBuilder.append({ ...order, customerName: "Buyer 😀" })).toBe(true);
    expect(exactBuilder.append({ ...order, id: "ord_2", customerName: "😀".repeat(32) })).toBe(false);
    const artifact = exactBuilder.finish();

    expect(artifact.byteLength).toBe(headerBytes + rowBytes);
    expect(artifact.rowCount).toBe(1);
    expect(artifact.truncatedByBytes).toBe(true);
    expect(artifact.chunks.join("")).not.toContain("ord_2");
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
