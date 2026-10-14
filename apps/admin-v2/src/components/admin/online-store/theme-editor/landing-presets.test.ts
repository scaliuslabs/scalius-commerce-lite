import { describe, expect, it } from "vitest";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { landingPresetSections, landingPresets } from "./landing-presets";

const field = (key: string, type: string) => ({
  key, label: key, help: null, type, required: false, options: null, default: null, min: null, max: null, integer: false, maxLength: null,
});

const app = {
  id: "acme.theme",
  name: "Acme theme",
  skins: [],
  templates: [],
  productBlocks: [],
  sections: [
    { key: "acme.theme/hero", type: "hero", name: "Hero", description: null, component: true, settings: [field("product", "product"), field("heading", "text")] },
    { key: "acme.theme/faq", type: "faq", name: "FAQ", description: null, component: true, settings: [field("heading", "text")] },
  ],
  pagePresets: [
    {
      key: "acme.theme/campaign",
      id: "campaign",
      name: "Campaign",
      description: "One product.",
      sections: [
        { id: "hero", type: "app", version: 1, settings: { app: "acme.theme/hero", values: { heading: "Offer" } } },
        { id: "faq", type: "app", version: 1, settings: { app: "acme.theme/faq", values: {} } },
      ],
    },
    {
      key: "acme.theme/story",
      id: "story",
      name: "Story",
      description: null,
      sections: [{ id: "faq", type: "app", version: 1, settings: { app: "acme.theme/faq", values: {} } }],
    },
  ],
} as unknown as ThemeApp;

describe("landing page presets", () => {
  it("lists each app's presets and says which need a product", () => {
    const presets = landingPresets([app]);
    expect(presets.map((preset) => [preset.key, preset.appName, preset.needsProduct])).toEqual([
      ["acme.theme/campaign", "Acme theme", true],
      ["acme.theme/story", "Acme theme", false],
    ]);
  });

  it("fills every product setting with the picked product and keeps the rest", () => {
    const [campaign] = landingPresets([app]);
    const sections = landingPresetSections(campaign!, [app], "prod_1");
    expect(sections[0]).toMatchObject({ settings: { app: "acme.theme/hero", values: { heading: "Offer", product: "prod_1" } } });
    expect(sections[1]).toEqual(campaign!.sections[1]);
    // Without a product the preset's own values stay.
    expect(landingPresetSections(campaign!, [app], null)).toEqual(campaign!.sections);
  });
});
