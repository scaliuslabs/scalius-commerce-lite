import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const WORKSPACE_SOURCES = [
  "./TaxSettingsPage.tsx",
  "./TaxSettingsPanel.tsx",
  "./TaxClassesPanel.tsx",
  "./TaxClassFormSheet.tsx",
  "./TaxRatesPanel.tsx",
  "./TaxRateFormSheet.tsx",
  "./TaxRateDiagnosticsPanel.tsx",
  "./TaxClassificationsPanel.tsx",
  "./TaxPreviewPanel.tsx",
] as const;

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

  it("saves the settings tab through the contextual save bar, never a per-card button", () => {
    const policy = source("./TaxSettingsPanel.tsx");

    expect(policy).toContain("ContextualSaveBar");
    expect(policy).toContain("isDirty={saveBar.visible}");
    expect(policy).toContain("saveDisabled={saveBar.saveDisabled}");
    expect(policy).toContain("onDiscard={() => setForm(savedForm)}");
    // The bar owns the unsaved-changes guard, so the old per-page guard and the
    // per-card Save/Reset pair must be gone.
    expect(policy).not.toContain("UnsavedChangesGuard");
    expect(policy).not.toMatch(/Save (policy|changes)/);
    expect(policy).not.toContain("Reset");
  });

  it("keeps catalog classification merchant-readable and responsive", () => {
    const classifications = source("./TaxClassificationsPanel.tsx");

    expect(classifications).toContain('to="/admin/products/$productId/edit"');
    expect(classifications).toContain("IndexTable");
    expect(classifications).toContain("IndexFilters");
    expect(classifications).toContain("Product / store default");
    expect(classifications).toContain("min-h-11");
    // The index table owns the mobile stacking, so the panel must not hand-roll
    // a second card layout beside the table.
    expect(classifications).not.toContain('className="space-y-2 md:hidden"');
    expect(classifications).not.toContain('className="hidden md:block"');
    expect(classifications).not.toContain('item.sku ? `SKU ${item.sku}` : item.productId');
  });

  it("keeps the full tax workspace practical on a phone", () => {
    const workspace = source("./TaxSettingsPage.tsx");
    const tabs = readFileSync(
      fileURLToPath(new URL("../shell/PageTabs.tsx", import.meta.url)),
      "utf8",
    );
    const policy = source("./TaxSettingsPanel.tsx");
    const classes = source("./TaxClassesPanel.tsx");
    const rates = source("./TaxRatesPanel.tsx");
    const rateForm = source("./TaxRateFormSheet.tsx");
    const diagnostics = source("./TaxRateDiagnosticsPanel.tsx");
    const preview = source("./TaxPreviewPanel.tsx");

    // The section switcher is the shell's, so the select-on-mobile behaviour
    // lives there instead of being rebuilt per workspace.
    expect(workspace).toContain("<PageTabs");
    expect(workspace).toContain('label="Tax workspace section"');
    expect(workspace).toContain('role="tabpanel"');
    expect(workspace).not.toContain("<TabsList");
    expect(workspace).not.toContain("overflow-x-auto");
    expect(tabs).toContain("min-h-11");
    expect(tabs).toContain('className="sm:hidden"');
    expect(tabs).toContain("sm:flex");
    expect(workspace).toContain('configuration.classes.length === 1 ? "class" : "classes"');
    expect(workspace).toContain('activeRateCount === 1 ? "rate" : "rates"');
    expect(policy).toContain("min-h-11");
    expect(classes).toContain("IndexTable");
    expect(rates).toContain("IndexTable");
    expect(rateForm).toContain("sm:grid-cols-2");
    expect(rateForm).toContain("min-h-11");
    expect(diagnostics).toContain("min-h-11");
    expect(preview).toContain("min-h-11");
  });

  it("edits and previews in the shared editor sheet, not hand-built sheets", () => {
    const workspace = source("./TaxSettingsPage.tsx");
    const rateForm = source("./TaxRateFormSheet.tsx");
    const classForm = source("./TaxClassFormSheet.tsx");

    for (const [name, file] of [
      ["TaxSettingsPage.tsx", workspace],
      ["TaxRateFormSheet.tsx", rateForm],
      ["TaxClassFormSheet.tsx", classForm],
    ] as const) {
      expect(file, `${name} must use the shell editor sheet`).toContain("<EditorSheet");
      expect(file, `${name} must not rebuild the sheet chrome`)
        .not.toContain("components/ui/sheet");
    }
    // The editor sheet owns the form, so the footer buttons submit it.
    expect(rateForm).toContain("onSubmit={submit}");
    expect(classForm).toContain("onSubmit={submit}");
  });

  it("pages the catalog list through the index table and debounces its search", () => {
    const classifications = source("./TaxClassificationsPanel.tsx");

    expect(classifications).toContain("pagination={{");
    expect(classifications).toContain("searchDebounceMs={SEARCH_COMMIT_DELAY_MS}");
    // The shell owns both now; the panel must not keep a second copy.
    expect(classifications).not.toContain("searchDraft");
    expect(classifications).not.toContain('aria-label="Previous page"');
  });

  it("marks deleting row actions as destructive through the menu primitive", () => {
    for (const name of ["./TaxRatesPanel.tsx", "./TaxClassesPanel.tsx"] as const) {
      const file = source(name);
      expect(file, `${name} must use the destructive menu item variant`)
        .toContain('variant="destructive"');
      expect(file, `${name} must not hand-roll the destructive tint`)
        .not.toContain("text-destructive focus:text-destructive");
    }
  });

  it("uses the shared shell instead of ad hoc badges and cards", () => {
    for (const name of WORKSPACE_SOURCES) {
      const file = source(name);
      expect(file, `${name} must not import the raw badge primitive`)
        .not.toContain("/components/ui/badge");
      expect(file, `${name} must not build its own empty state`)
        .not.toContain("border-dashed p-10");
    }

    expect(source("./TaxSettingsPage.tsx")).toContain(
      '~/components/admin/shell/PageHeader',
    );
    expect(source("./TaxSettingsPage.tsx")).toContain(
      '~/components/admin/shell/SkeletonPage',
    );
    expect(source("./TaxSettingsPanel.tsx")).toContain(
      '~/components/admin/shell/SettingsSection',
    );
    expect(source("./TaxRatesPanel.tsx")).toContain(
      '~/components/admin/shell/EmptyState',
    );
  });

  it("keeps merchant copy in sentence case with no exclamation marks", () => {
    for (const name of WORKSPACE_SOURCES) {
      expect(source(name), `${name} must not shout at the merchant`)
        .not.toMatch(/[a-z]!["<]/);
    }
  });
});
