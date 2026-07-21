import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("fraud checker workspace presentation", () => {
  it("states the real order-only consequence without implying checkout enforcement", () => {
    const component = readSource("./FraudCheckerSettings.tsx");
    const route = readSource("../../routes/admin/settings/fraud-checker.tsx");

    expect(route).toContain("on-demand risk checks in Orders");
    expect(component).toContain("Fraud checks do not block checkout automatically");
    expect(component).toContain("This enables manual checks in Orders");
    expect(component).toContain("Results are shown for this browser session only");
  });

  it("separates setup, activation, and current-session connection evidence", () => {
    const source = readSource("./FraudCheckerSettings.tsx");

    expect(source).toContain("Credentials saved");
    expect(source).toContain("Used in Orders");
    expect(source).toContain("Not checked this session");
    expect(source).toContain("Passed this session");
    expect(source).toContain("Failed this session");
    expect(source).toContain("Technical details");
  });

  it("keeps mutations permission-aware, keyboard accessible, and usable on phones", () => {
    const source = readSource("./FraudCheckerSettings.tsx");
    const permissions = readSource("../../lib/admin-permissions.ts");

    expect(permissions).toContain("SETTINGS_FRAUD_CHECKER_EDIT");
    expect(source).toContain("const canEdit = hasPermission");
    expect(source).toContain("Read-only access");
    expect(source).toContain("aria-pressed={selectedProvider?.id === provider.id}");
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("min-h-11");
    expect(source).not.toContain("cursor-pointer text-sm transition-colors");
    expect(source).not.toContain('className="h-7 text-xs"');
  });

  it("uses the compact settings heading", () => {
    const route = readSource("../../routes/admin/settings/fraud-checker.tsx");

    expect(route).toContain('text-xl font-semibold tracking-tight');
    expect(route).not.toContain("text-3xl");
  });
});
