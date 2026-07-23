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
    expect(policy).toContain("UnsavedChangesGuard");
    expect(policy).toContain("Reset");
    expect(policy).toContain("!isDirty");
    expect(policy).not.toContain("Release-safe behavior");
    expect(policy).not.toContain("Configuration version");
    expect(readiness).not.toContain("Lifecycle checks");
    expect(diagnostics).toContain("Coverage check");
    expect(diagnostics).toContain("Add broad rate");
    expect(diagnostics).toContain("Review rate");
    expect(diagnostics).toContain("Test a destination");
  });

  it("keeps catalog classification merchant-readable and responsive", () => {
    const classifications = source("./TaxClassificationsPanel.tsx");

    expect(classifications).toContain('to="/admin/products/$productId/edit"');
    expect(classifications).toContain('className="space-y-2 md:hidden"');
    expect(classifications).toContain('className="hidden md:block"');
    expect(classifications).toContain("Product / store default");
    expect(classifications).toContain("min-h-11");
    expect(classifications).not.toContain('item.sku ? `SKU ${item.sku}` : item.productId');
  });

  it("keeps the full tax workspace practical on a phone", () => {
    const workspace = source("./TaxSettingsPage.tsx");
    const policy = source("./TaxSettingsPanel.tsx");
    const classes = source("./TaxClassesPanel.tsx");
    const rates = source("./TaxRatesPanel.tsx");
    const diagnostics = source("./TaxRateDiagnosticsPanel.tsx");
    const preview = source("./TaxPreviewPanel.tsx");

    expect(workspace).toContain("min-h-11");
    expect(workspace).toContain('aria-label="Tax workspace section"');
    expect(workspace).toContain('className="sm:hidden"');
    expect(workspace).toContain("sm:flex");
    expect(workspace).not.toContain("overflow-x-auto");
    expect(workspace).toContain('configuration.classes.length === 1 ? "class" : "classes"');
    expect(workspace).toContain('activeRateCount === 1 ? "rate" : "rates"');
    expect(policy).toContain("min-h-11");
    expect(policy).toContain("{isDirty ? (");
    expect(classes).toContain('className="space-y-2 md:hidden"');
    expect(classes).toContain('className="hidden md:block"');
    expect(rates).toContain('className="space-y-2 md:hidden"');
    expect(rates).toContain('className="hidden md:block"');
    expect(rates).toContain("sm:grid-cols-2");
    expect(diagnostics).toContain("min-h-11");
    expect(preview).toContain("min-h-11");
  });
});
