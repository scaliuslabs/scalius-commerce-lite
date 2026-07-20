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
    const rates = source("./TaxRatesPanel.tsx");

    expect(rates).toContain('<SearchableSelect');
    expect(rates).toContain('id="tax-rate-jurisdiction"');
    expect(rates).toContain('maxVisibleOptions={100}');
    expect(rates).not.toContain('<Select value={draft.jurisdictionId}');
  });
});
