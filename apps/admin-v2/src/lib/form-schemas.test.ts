import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SCHEMAS_SOURCE = fileURLToPath(
  new URL("./form-schemas.ts", import.meta.url),
);
const ANALYTICS_FORM_SOURCE = fileURLToPath(
  new URL("../components/admin/AnalyticsForm.tsx", import.meta.url),
);
const ANALYTICS_LIST_SOURCE = fileURLToPath(
  new URL("../components/admin/AnalyticsList.tsx", import.meta.url),
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

  it("keeps TikTok Pixel as a first-class guided script type", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");
    const analyticsFormSource = readFileSync(ANALYTICS_FORM_SOURCE, "utf8");
    const analyticsListSource = readFileSync(ANALYTICS_LIST_SOURCE, "utf8");

    expect(formSchemasSource).toMatch(
      /analyticsScriptTypes = \[[\s\S]*"tiktok_pixel"/,
    );
    expect(analyticsFormSource).toContain(
      "tiktok_pixel: `<!-- TikTok Pixel Code -->",
    );
    expect(analyticsFormSource).toContain(
      '<SelectItem value="tiktok_pixel">',
    );
    expect(analyticsFormSource).toContain(
      "https://analytics.tiktok.com/i18n/pixel/events.js",
    );
    expect(analyticsFormSource).toContain("ttq.load('PIXEL_ID')");
    expect(analyticsFormSource).toContain("ttq.page()");
    expect(analyticsListSource).toContain('case "tiktok_pixel":');
    expect(analyticsListSource).toContain('return "TikTok Pixel";');
  });
});
