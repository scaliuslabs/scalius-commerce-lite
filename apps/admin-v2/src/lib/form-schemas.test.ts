import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SCHEMAS_SOURCE = fileURLToPath(
  new URL("./form-schemas.ts", import.meta.url),
);
const ANALYTICS_FORM_SOURCE = fileURLToPath(
  new URL("../components/admin/AnalyticsForm.tsx", import.meta.url),
);

describe("analytics form schema", () => {
  it("keeps Google Tag Manager as a first-class guided script type", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");
    const analyticsFormSource = readFileSync(ANALYTICS_FORM_SOURCE, "utf8");

    expect(formSchemasSource).toMatch(
      /analyticsScriptTypes = \[[\s\S]*"google_tag_manager"/,
    );
    expect(analyticsFormSource).toContain(
      "google_tag_manager: `<!-- Google Tag Manager -->",
    );
    expect(analyticsFormSource).toContain(
      '<SelectItem value="google_tag_manager">',
    );
    expect(analyticsFormSource).toContain("GTM-XXXXXXX");
    expect(analyticsFormSource).toContain("G-XXXXXXXXXX");
  });
});
