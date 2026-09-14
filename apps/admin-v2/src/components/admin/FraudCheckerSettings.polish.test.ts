import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("fraud checker workspace presentation", () => {
  it("states the real order-only consequence without implying checkout enforcement", () => {
    const component = readSource("./FraudCheckerSettings.tsx");
    const route = readSource("../../routes/admin/settings/fraud-checker.tsx");

    expect(route).toContain(
      "Risk lookup providers a merchant can run while reviewing an order.",
    );
    expect(component).toContain("Checks are manual and never block checkout");
    expect(component).toContain("Manual check only; checkout remains unaffected");
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
    expect(source).toContain(
      'aria-current={selectedProvider?.id === provider.id ? "true" : undefined}',
    );
    // IndexTable rows are keyboard reachable (Tab, then Enter or Space).
    expect(source).toContain("<IndexTable");
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("min-h-11");
    expect(source).not.toContain("cursor-pointer text-sm transition-colors");
    expect(source).not.toContain('className="h-7 text-xs"');
  });

  it("lists providers with the shared index table, empty state, and status badges", () => {
    const source = readSource("./FraudCheckerSettings.tsx");

    expect(source).toContain('from "~/components/admin/shell"');
    expect(source).toContain("<EmptyState");
    expect(source).toContain("<SettingsSection");
    expect(source).toContain("<StatusBadge");
    expect(source).toContain("rowActions=");
    expect(source).toContain("<DropdownMenu>");
    expect(source).toContain("canSave={canEdit}");
    // Ad hoc card scaffolding and coloured pills are gone.
    expect(source).not.toContain('from "@/components/ui/card"');
    expect(source).not.toContain("<CardTitle");
    expect(source).not.toContain('from "@/components/ui/badge"');
  });

  it("uses the shared settings page header instead of a hand-rolled heading", () => {
    const route = readSource("../../routes/admin/settings/fraud-checker.tsx");

    expect(route).toContain("<SettingsLayout");
    expect(route).toContain('title="Fraud checks"');
    expect(route).not.toContain("text-3xl");
    // The page title lives in PageHeader, never duplicated inside a card.
    expect(route).not.toContain("<h1");
  });

  it("keeps an empty create flow focused on one editor", () => {
    const source = readSource("./FraudCheckerSettings.tsx");

    expect(source).toContain("providers.length > 0 ? (");
    expect(source).toContain("providers.length === 0 && !isCreating ? (");
    expect(source).toContain("New provider");
    expect(source).toContain('saveLabel="Save provider"');
    // One save bar owns the provider draft; no per-card Save/Cancel row.
    expect(source).toContain("isDirty={isDraftDirty || isSaving}");
    expect(source).toContain("const isDraftDirty = isEditing && form.formState.isDirty");
    expect(source).not.toContain("Finish or cancel this new provider");
    expect(source).not.toContain(': "No changes"');
  });
});
