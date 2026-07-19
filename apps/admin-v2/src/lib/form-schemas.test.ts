import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SCHEMAS_SOURCE = fileURLToPath(
  new URL("./form-schemas.ts", import.meta.url),
);
const ANALYTICS_SCRIPT_TYPES_SOURCE = fileURLToPath(
  new URL("./analytics-script-types.ts", import.meta.url),
);
const ANALYTICS_FORM_SOURCE = fileURLToPath(
  new URL("../components/admin/AnalyticsForm.tsx", import.meta.url),
);
const ANALYTICS_LIST_SOURCE = fileURLToPath(
  new URL("../components/admin/analytics-list-presentation.ts", import.meta.url),
);

describe("analytics form schema", () => {
  it("keeps Google Tag Manager as a first-class guided script type", () => {
    const analyticsTypesSource = readFileSync(ANALYTICS_SCRIPT_TYPES_SOURCE, "utf8");
    const analyticsFormSource = readFileSync(ANALYTICS_FORM_SOURCE, "utf8");

    expect(analyticsTypesSource).toMatch(
      /analyticsScriptTypes = \[[\s\S]*"google_tag_manager"/,
    );
    expect(analyticsFormSource).toContain("google_tag_manager: `<!-- Google Tag Manager -->");
    expect(analyticsFormSource).toContain('type: "google_tag_manager"');
    expect(analyticsFormSource).toContain("GTM-XXXXXXX");
    expect(analyticsFormSource).toContain("G-XXXXXXXXXX");
  });

  it("keeps TikTok Pixel as a first-class guided script type", () => {
    const analyticsTypesSource = readFileSync(ANALYTICS_SCRIPT_TYPES_SOURCE, "utf8");
    const analyticsFormSource = readFileSync(ANALYTICS_FORM_SOURCE, "utf8");
    const analyticsListSource = readFileSync(ANALYTICS_LIST_SOURCE, "utf8");

    expect(analyticsTypesSource).toMatch(
      /analyticsScriptTypes = \[[\s\S]*"tiktok_pixel"/,
    );
    expect(analyticsFormSource).toContain(
      "tiktok_pixel: `<!-- TikTok Pixel Code -->",
    );
    expect(analyticsFormSource).toContain('type: "tiktok_pixel"');
    expect(analyticsFormSource).toContain(
      "https://analytics.tiktok.com/i18n/pixel/events.js",
    );
    expect(analyticsFormSource).toContain("ttq.load('PIXEL_ID')");
    expect(analyticsFormSource).toContain("ttq.page()");
    expect(analyticsListSource).toContain('tiktok_pixel: "TikTok Pixel"');
  });

  it("blocks active Cloudflare Web Analytics placeholder tokens in the guided form", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");
    const analyticsFormSource = readFileSync(ANALYTICS_FORM_SOURCE, "utf8");

    expect(formSchemasSource).toContain("getActiveAnalyticsConfigError(data)");
    expect(formSchemasSource).toContain('path: ["config"]');
    expect(analyticsFormSource).toContain('type: "cloudflare_web_analytics"');
    expect(analyticsFormSource).toContain('placeholder="Paste the Web Analytics site token"');
  });
});

describe("resource form canonical validation", () => {
  it("uses resource-aware canonical route validators for category and page forms", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");

    expect(formSchemasSource).toContain("isValidResourceCanonicalPath");
    expect(formSchemasSource).toMatch(
      /canonicalPathFormSchema\(\s*"category"\s*,\s*"\/categories\/summer-shoes"\s*,?\s*\)/,
    );
    expect(formSchemasSource).toContain('"/categories/summer-shoes"');
    expect(formSchemasSource).toContain('canonicalPathFormSchema("page", "/returns")');
  });
});
