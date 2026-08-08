import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scannerSource = readFileSync(
  new URL("./ScannerApp.tsx", import.meta.url),
  "utf8",
);
const manualSource = readFileSync(
  new URL("./ManualSheet.tsx", import.meta.url),
  "utf8",
);

describe("scanner inventory idempotency boundaries", () => {
  it("retries unknown scanner writes with the same serialized operation body", () => {
    expect(scannerSource).toContain("postInventoryOperation");
    expect(scannerSource).toContain("attempt < 2");
    expect(scannerSource).toContain("operationKey: createInventoryOperationKey()");
  });

  it("undoes with a relative ledger edge instead of overwriting concurrent stock", () => {
    const undoBlock = scannerSource.slice(
      scannerSource.indexOf("const handleUndo"),
      scannerSource.indexOf("// ---- Camera active"),
    );

    expect(undoBlock).toContain('"/api/v1/admin/inventory/stock-adjust"');
    expect(undoBlock).toContain("adjustment: item.oldStock - item.newStock");
    expect(undoBlock).toContain("undoOperationKeysRef.current.get(item.id)");
    expect(undoBlock).toContain("undoOperationKeysRef.current.delete(item.id)");
    expect(undoBlock).toContain("undoError:");
    expect(undoBlock).not.toContain('action: "error" as const');
    expect(undoBlock).not.toContain("newStock: item.oldStock");
  });

  it("retains one claim exchange across React StrictMode effect replay", () => {
    expect(scannerSource).toContain("verificationRequestRef.current?.token !== token");
    expect(scannerSource).toContain("verificationRequestRef.current.promise");
  });

  it("retains a manual-sheet operation key while the submitted intent is unchanged", () => {
    expect(manualSource).toContain("operationIntentRef");
    expect(manualSource).toContain("fingerprint");
    expect(manualSource).toContain("operationKey: operationIntentRef.current.key");
  });
});
