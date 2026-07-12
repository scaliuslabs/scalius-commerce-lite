import { describe, expect, it } from "vitest";
import {
  attributeAssignmentSignature,
  mergeAttributeValuePages,
} from "./attribute-manager.helpers";

describe("AttributeManager boundaries", () => {
  it("uses a stable canonical assignment signature for parent synchronization", () => {
    expect(attributeAssignmentSignature([
      { attributeId: " attr_material ", value: " Cotton " },
      { attributeId: "attr_brand", value: "Scalius" },
    ])).toBe("attr_material\u0000Cotton\u0001attr_brand\u0000Scalius");
  });

  it("deduplicates paged values by normalized identity while keeping the newest row", () => {
    expect(mergeAttributeValuePages(
      [{ value: " Cotton ", isPreset: false }],
      [
        { value: "cotton", isPreset: true },
        { value: "Linen", isPreset: false },
      ],
    )).toEqual([
      { value: "cotton", isPreset: true },
      { value: "Linen", isPreset: false },
    ]);
  });
});
