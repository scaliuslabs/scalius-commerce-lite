import { describe, expect, it } from "vitest";

import { parseIsoCalendarDate, validateSourceManifest } from "./provenance.mjs";

const expected = [{ logicalKey: "product:test:primary", kind: "image" }];

function generatedRecord() {
  return {
    logicalKey: "product:test:primary",
    status: "approved",
    sourceKind: "generated-original",
    sourceFile: "test.png",
    creator: "Scalius demo studio",
    license: {
      code: "Generated-Original",
      url: "https://www.scalius.com/asset-rights",
      attribution: "",
    },
    acquiredAt: "2026-07-12",
    verifiedAt: "2026-07-13",
    sha256: "a".repeat(64),
    original: { mime: "image/png", bytes: 10, width: 10, height: 10 },
    cropPosition: "centre",
    generation: { prompt: "A rights-safe product image", model: "gpt-image-2" },
    rightsReview: {
      reviewedBy: "demo-reviewer",
      noWatermark: true,
      noVisibleBranding: true,
      noTrademarkedCharacter: true,
      noIdentifiableEndorser: true,
      optionAppearanceVerified: true,
    },
  };
}

describe("demo asset provenance", () => {
  it("parses only real ISO calendar dates", () => {
    expect(parseIsoCalendarDate("2024-02-29")).toBe(20240229);
    expect(parseIsoCalendarDate("2023-02-29")).toBeNull();
    expect(parseIsoCalendarDate("2026-04-31")).toBeNull();
    expect(parseIsoCalendarDate("2026-7-13")).toBeNull();
    expect(parseIsoCalendarDate("0000-01-01")).toBeNull();
  });

  it("enforces source-kind and license semantic pairing", () => {
    const generated = generatedRecord();
    generated.license.code = "Pexels";
    const merchant = {
      ...generatedRecord(),
      sourceKind: "merchant-owned",
      merchantOwnershipReference: "internal release 42",
      license: { ...generated.license, code: "Generated-Original" },
      generation: undefined,
    };

    for (const record of [generated, merchant]) {
      const result = validateSourceManifest(
        { schemaVersion: 1, assets: [record] },
        expected,
        { today: "2026-07-13" },
      );
      expect(result.errors).toContain("assets[0].license.code does not match sourceKind " + record.sourceKind);
    }
  });

  it("requires generation prompt and model for generated originals", () => {
    const record = generatedRecord();
    record.generation = { prompt: " ", model: "" };
    const result = validateSourceManifest(
      { schemaVersion: 1, assets: [record] },
      expected,
      { today: "2026-07-13" },
    );
    expect(result.errors).toContain("assets[0].generation prompt and model are required");
  });

  it("enforces acquired <= verified <= today with real dates", () => {
    const invalidCalendar = generatedRecord();
    invalidCalendar.acquiredAt = "2026-02-30";
    const reversed = generatedRecord();
    reversed.acquiredAt = "2026-07-13";
    reversed.verifiedAt = "2026-07-12";
    const future = generatedRecord();
    future.verifiedAt = "2026-07-14";

    const records = [invalidCalendar, reversed, future];
    const expectedErrors = [
      "assets[0].acquiredAt must be a real ISO calendar date",
      "assets[0].acquiredAt must be on or before verifiedAt",
      "assets[0].verifiedAt cannot be in the future",
    ];
    records.forEach((record, index) => {
      const result = validateSourceManifest(
        { schemaVersion: 1, assets: [record] },
        expected,
        { today: "2026-07-13" },
      );
      expect(result.errors).toContain(expectedErrors[index]);
    });
  });
});
