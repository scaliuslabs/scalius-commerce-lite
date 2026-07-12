import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./order-returns.ts", import.meta.url)),
  "utf8",
);

describe("item-return recovery boundaries", () => {
  it("persists canonical recovery input and exposes only sanitized recovery state", () => {
    expect(source).toContain('requestPayload: sql<string>`${stableStringify(input)}`');
    expect(source).toContain("activeCommandKey,\n    activeCommandStartedAt,\n    ...publicHeader");
    expect(source).toContain("receiptRecovery: activeCommandKey");
    expect(source).not.toContain("receiptRecovery: { commandKey");
  });

  it("links immutable dispositions to deterministic movements and the receiving actor", () => {
    expect(source).toContain("return-receipt:v1:${returnId}:${input.commandKey}:${line.id}");
    expect(source).toContain("createdBy: receiptActor.id ?? null");
    expect(source).toContain("inventoryMovementId:");
    expect(source).toContain("orderReturnReceiptLines");
  });

  it("derives full-order returned state from received item quantities only", () => {
    expect(source).toContain("shouldMarkWholeOrderReturned");
    expect(source).toContain("receivedByItem");
    expect(source).toContain("=== item.quantity");
  });
});
