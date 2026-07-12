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

  it("retains a manual-sheet operation key while the submitted intent is unchanged", () => {
    expect(manualSource).toContain("operationIntentRef");
    expect(manualSource).toContain("fingerprint");
    expect(manualSource).toContain("operationKey: operationIntentRef.current.key");
  });
});
