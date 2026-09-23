import { describe, expect, it } from "vitest";
import { describeMovementNote } from "./movement-note";

const row = (notes: string | null, extra: { orderId?: string | null; actorType?: "system" | "admin" } = {}) =>
  describeMovementNote({ notes, orderId: extra.orderId ?? null, actorType: extra.actorType ?? "admin" });

describe("describeMovementNote", () => {
  it("maps dashboard, scanner and stock-count sentences to labels and keeps the typed note", () => {
    expect(row("Manual adjustment (received): Supplier box 12")).toEqual({ labels: ["reason_received"], note: "Supplier box 12" });
    expect(row("Manual adjustment (damage)")).toEqual({ labels: ["reason_damage"], note: null });
    expect(row("Scanner adjustment (Quick Deduct)")).toEqual({ labels: ["sourceScanner", "reason_removed"], note: null });
    expect(row("Stocktake (Manual stocktake): set from 0 to 7")).toEqual({ labels: ["sourceStockCount"], note: null });
    expect(row("Stocktake (Shelf B recount): set from 3 to 2")).toEqual({ labels: ["sourceStockCount"], note: "Shelf B recount" });
  });

  it("names product-page changes instead of showing internal source text", () => {
    expect(row("Stocktake: Option matrix edit")).toEqual({ labels: ["sourceProductEdit"], note: null });
    expect(row("Stocktake: Initial product stock")).toEqual({ labels: ["sourceProductCreated"], note: null });
  });

  it("hides server sentences about orders and system work", () => {
    expect(row("Stock deducted on order status transition for order JMT1AZTX", { orderId: "JMT1AZTX", actorType: "system" }).note).toBeNull();
    expect(row("Deducted stock restored")).toEqual({ labels: [], note: null });
    expect(row("Reservation rollback (batch failure)", { actorType: "system" })).toEqual({ labels: ["sourceCheckoutFailed"], note: null });
    expect(row("Legacy note from a person")).toEqual({ labels: [], note: "Legacy note from a person" });
    expect(row(null)).toEqual({ labels: [], note: null });
  });
});
