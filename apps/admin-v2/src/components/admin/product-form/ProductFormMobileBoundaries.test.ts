import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (fileName: string) =>
  readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8");

describe("product editor mobile boundaries", () => {
  it.each([
    "TitleDescriptionSection.tsx",
    "PricingCard.tsx",
    "StatusCard.tsx",
    "OrganizationCard.tsx",
    "CollapsibleCard.tsx",
  ])("keeps phone controls operable without changing desktop density in %s", (fileName) => {
    const source = readSource(fileName);
    expect(source).toContain("min-h-11");
    expect(source).toMatch(/md:(?:h|min-h)-(?:0|7|8|9|10)/);
  });

  it("keeps switch visuals compact while extending their phone hit area", () => {
    const source = readSource("StatusCard.tsx");
    expect(source).toContain("before:-inset-x-1");
    expect(source).toContain("before:-inset-y-3");
  });

  it("removes redundant merchant guidance from compact editor states", () => {
    expect(readSource("PricingCard.tsx")).not.toContain(
      "Set the regular selling price.",
    );
    expect(readSource("AdditionalInfoManager.tsx")).not.toContain(
      "Click below to add",
    );
    expect(readSource("ProductImagesSection.tsx")).not.toContain(
      "Image-only surfaces use",
    );
  });
});
