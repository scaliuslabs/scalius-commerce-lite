import { describe, expect, it } from "vitest";
import {
  createWidgetCompositionContract,
  createWidgetCompositionPlan,
  WIDGET_DESTINATION_RUNTIME_CONTRACTS,
} from "./destination-contracts";

describe("widget destination contracts", () => {
  it("creates distinct composition plans for each storefront destination", () => {
    const homepage = createWidgetCompositionPlan("widget");
    const landing = createWidgetCompositionPlan("landing-page");
    const collection = createWidgetCompositionPlan("collection");

    expect(homepage.totalSections).toBeLessThan(landing.totalSections);
    expect(homepage.compositionBrief).toContain("homepage merchandising");
    expect(landing.compositionBrief).toContain("campaign");
    expect(collection.compositionBrief).toContain("merchandising flow");
    expect(collection.sectionDescriptions.join(" ")).toContain("Product grid");
  });

  it("keeps runtime contracts destination-specific", () => {
    expect(WIDGET_DESTINATION_RUNTIME_CONTRACTS.widget).toContain("Homepage Widget");
    expect(WIDGET_DESTINATION_RUNTIME_CONTRACTS.widget).toContain("not a full-page campaign");
    expect(WIDGET_DESTINATION_RUNTIME_CONTRACTS["landing-page"]).toContain("conversion flow");
    expect(WIDGET_DESTINATION_RUNTIME_CONTRACTS.collection).toContain("Product comparison");
  });

  it("builds a single-pass composition contract without client-owned prompt duplication", () => {
    const contract = createWidgetCompositionContract("landing-page");

    expect(contract).toContain("SERVER COMPOSITION BLUEPRINT");
    expect(contract).toContain("SINGLE-PASS COMPOSITION RULES");
    expect(contract).toContain("platform adds the runtime wrapper");
    expect(contract).toContain("do not use widget-container");
    expect(contract).toContain("Final conversion CTA");
  });
});
