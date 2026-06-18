import { describe, expect, it } from "vitest";

import { processAnalyticsScript, shouldUsePartytown } from "./analytics";

const baseScript = {
  id: "analytics_1",
  name: "Analytics",
  type: "custom",
  isActive: true,
  usePartytown: true,
  config: "<script>window.test = true;</script>",
  location: "head",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("analytics script processing", () => {
  it("keeps Cloudflare Web Analytics on the main thread", () => {
    expect(
      shouldUsePartytown({
        ...baseScript,
        type: "cloudflare_web_analytics",
        usePartytown: true,
      }),
    ).toBe(false);
  });

  it("adds Partytown type to ordinary scripts when enabled", () => {
    expect(processAnalyticsScript(baseScript)).toContain(
      '<script type="text/partytown">',
    );
  });
});
