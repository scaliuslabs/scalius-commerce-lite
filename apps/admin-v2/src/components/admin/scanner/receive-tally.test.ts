import { describe, expect, it } from "vitest";
import {
  clampTally,
  countedTotal,
  createIntentKeys,
  matchLine,
  receiveFingerprint,
  receiveLines,
  setCounted,
  tallyScan,
  type ReceiveLine,
  type ReceiveTally,
} from "./receive-tally";

const lines: ReceiveLine[] = [
  { id: "pol_1", sku: "PANJABI-M-WHITE", barcode: "8901234567890", productName: "Panjabi", optionLabel: "M / White", open: 2 },
  { id: "pol_2", sku: "SAREE-RED", barcode: null, productName: "Saree", optionLabel: null, open: 1 },
  { id: "pol_3", sku: "OLD-MUG", barcode: "2000000000017", productName: "Mug", optionLabel: null, open: 4, blocked: true },
];

describe("matchLine", () => {
  it("matches a line by barcode, else by SKU, ignoring case and spaces", () => {
    expect(matchLine(lines, "8901234567890")?.id).toBe("pol_1");
    expect(matchLine(lines, "  saree-red \n")?.id).toBe("pol_2");
    expect(matchLine(lines, "panjabi-m-white")?.id).toBe("pol_1");
  });

  it("matches nothing for an unknown or empty code", () => {
    expect(matchLine(lines, "NOT-ON-PO")).toBeNull();
    expect(matchLine(lines, "   ")).toBeNull();
  });
});

describe("tallyScan", () => {
  it("counts one unit per scan up to what is still open, then says all are counted", () => {
    let tally: ReceiveTally = {};
    const first = tallyScan(lines, tally, "8901234567890");
    expect(first.outcome).toMatchObject({ kind: "counted", counted: 1, line: { id: "pol_1" } });
    tally = first.tally;
    const second = tallyScan(lines, tally, "PANJABI-M-WHITE");
    expect(second.outcome).toMatchObject({ kind: "counted", counted: 2 });
    tally = second.tally;
    const third = tallyScan(lines, tally, "8901234567890");
    expect(third.outcome).toMatchObject({ kind: "full", line: { id: "pol_1" } });
    expect(third.tally).toBe(tally);
    expect(tally).toEqual({ pol_1: 2 });
  });

  it("reports a code that is on no line without counting anything", () => {
    const tally = { pol_2: 1 };
    const result = tallyScan(lines, tally, "999");
    expect(result.outcome).toEqual({ kind: "unknown" });
    expect(result.tally).toBe(tally);
  });

  it("never counts a line that can't be received (a retired SKU on a purchase order)", () => {
    const result = tallyScan(lines, {}, "2000000000017");
    expect(result.outcome).toMatchObject({ kind: "blocked", line: { id: "pol_3" } });
    expect(result.tally).toEqual({});
  });
});

describe("setCounted and clampTally", () => {
  it("keeps a hand count between zero and what is open", () => {
    expect(setCounted(lines, {}, "pol_1", 5)).toEqual({ pol_1: 2 });
    expect(setCounted(lines, { pol_1: 2 }, "pol_1", 1)).toEqual({ pol_1: 1 });
    expect(setCounted(lines, { pol_1: 1, pol_2: 1 }, "pol_1", 0)).toEqual({ pol_2: 1 });
    expect(setCounted(lines, {}, "pol_3", 2)).toEqual({});
    expect(setCounted(lines, {}, "missing", 2)).toEqual({});
  });

  it("shrinks counts to what is still open after a reload", () => {
    const reloaded = [{ ...lines[0]!, open: 1 }, lines[1]!];
    expect(clampTally(reloaded, { pol_1: 2, pol_2: 1, gone: 3 })).toEqual({ pol_1: 1, pol_2: 1 });
  });
});

describe("receive command", () => {
  it("sends every counted line in the document's order", () => {
    const tally = { pol_2: 1, pol_1: 2 };
    expect(receiveLines(lines, tally)).toEqual([
      { lineId: "pol_1", quantity: 2 },
      { lineId: "pol_2", quantity: 1 },
    ]);
    expect(countedTotal(tally)).toBe(3);
  });

  it("reuses one operation key for a retried intent and makes a new one once it settled or changed", () => {
    let made = 0;
    const keys = createIntentKeys(() => `invop_test_key_${++made}`);
    const intent = receiveFingerprint({
      kind: "purchaseOrder",
      documentId: "po_1",
      revision: 3,
      lines: [{ lineId: "pol_1", quantity: 2 }],
      updateCost: false,
    });
    const first = keys.keyFor(intent);
    expect(keys.keyFor(intent)).toBe(first);
    // A different count (or the cost switch) is a different receipt.
    const changed = receiveFingerprint({
      kind: "purchaseOrder",
      documentId: "po_1",
      revision: 3,
      lines: [{ lineId: "pol_1", quantity: 2 }],
      updateCost: true,
    });
    expect(keys.keyFor(changed)).not.toBe(first);
    // Booked: the next delivery of the same count is a new receipt.
    const again = keys.keyFor(intent);
    keys.settle();
    expect(keys.keyFor(intent)).not.toBe(again);
  });

  it("makes keys the API accepts", () => {
    const key = createIntentKeys().keyFor("intent");
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
  });
});
