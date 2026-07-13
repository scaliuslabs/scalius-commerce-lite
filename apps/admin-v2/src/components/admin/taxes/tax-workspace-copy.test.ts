import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("tax workspace merchant copy", () => {
  it("uses checkout and coverage outcomes instead of implementation language", () => {
    const policy = source("./TaxSettingsPanel.tsx");
    const readiness = source("./tax-readiness.ts");
    const diagnostics = source("./TaxRateDiagnosticsPanel.tsx");

    expect(policy).toContain("Checkout outcome");
    expect(policy).not.toContain("Release-safe behavior");
    expect(policy).not.toContain("Configuration version");
    expect(readiness).not.toContain("Lifecycle checks");
    expect(diagnostics).toContain("Coverage check");
    expect(diagnostics).toContain("Add broad rate");
    expect(diagnostics).toContain("Review rate");
    expect(diagnostics).toContain("Test a destination");
  });
});
