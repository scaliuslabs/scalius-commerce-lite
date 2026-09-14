import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("tax destination selector boundaries", () => {
  it("uses searchable cascading destinations in the calculation preview", () => {
    const preview = source("./TaxPreviewPanel.tsx");

    expect(preview).toContain('import { SearchableSelect }');
    expect(preview).toContain('searchPlaceholder="Search cities…"');
    expect(preview).toContain('searchPlaceholder="Search zones…"');
    expect(preview).toContain('searchPlaceholder="Search areas…"');
    expect(preview).toContain('setZone(""); setArea(NO_AREA)');
    expect(preview).not.toContain('<Select value={city}');
    expect(preview).not.toContain('<Select value={zone}');
  });

  it("keeps large saved-destination lists searchable in the rate editor", () => {
    const rateForm = source("./TaxRateFormSheet.tsx");

    expect(rateForm).toContain('<SearchableSelect');
    expect(rateForm).toContain('id="tax-rate-jurisdiction"');
    expect(rateForm).toContain('maxVisibleOptions={100}');
    expect(rateForm).not.toContain('<Select value={draft.jurisdictionId}');
  });

  it("opens the preview from the workspace as a side sheet, not a tab", () => {
    const workspace = source("./TaxSettingsPage.tsx");

    expect(workspace).toContain("<EditorSheet");
    expect(workspace).toContain("open={previewOpen}");
    expect(workspace).toContain("Preview calculation");
    expect(workspace).toContain("<TaxPreviewPanel configuration={configuration} />");
    expect(workspace).not.toContain('TabsContent value="preview"');
  });
});
