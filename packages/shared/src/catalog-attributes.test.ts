import { describe, expect, it } from "vitest";

import {
  attributeDefinitionSchema,
  attributeFacetValueKey,
  canonicalAttributeNumber,
  defaultAttributeFacetDisplay,
  isAttributeFacetDisplayAllowed,
  normalizeAttributeValue,
  optionFacetKey,
  parseAttributeNumber,
} from "./catalog-attributes";

describe("typed attributes", () => {
  it("allows a range only for numbers and swatches only for enums", () => {
    expect(isAttributeFacetDisplayAllowed("number", "range")).toBe(true);
    expect(isAttributeFacetDisplayAllowed("text", "range")).toBe(false);
    expect(isAttributeFacetDisplayAllowed("enum", "swatch")).toBe(true);
    expect(isAttributeFacetDisplayAllowed("boolean", "swatch")).toBe(false);
    expect(defaultAttributeFacetDisplay("number")).toBe("range");
    const base = { unit: null, keySpec: true, highlight: false, sortOrder: 0 };
    expect(attributeDefinitionSchema.safeParse({ ...base, valueType: "text", facetDisplay: "range" }).success).toBe(false);
    expect(attributeDefinitionSchema.safeParse({ ...base, valueType: "enum", unit: "GB", facetDisplay: "checkbox" }).success).toBe(false);
    expect(attributeDefinitionSchema.safeParse({ ...base, valueType: "number", unit: "GB", facetDisplay: "range" }).success).toBe(true);
  });

  it("writes one canonical text per number", () => {
    expect(canonicalAttributeNumber(15.6)).toBe("15.6");
    expect(canonicalAttributeNumber(15.60)).toBe("15.6");
    expect(canonicalAttributeNumber(1e3)).toBe("1000");
    expect(canonicalAttributeNumber(0.1 + 0.2)).toBe("0.3");
    expect(canonicalAttributeNumber(-0)).toBe("0");
    expect(() => canonicalAttributeNumber(Number.NaN)).toThrow(RangeError);
    expect(parseAttributeNumber(" 1,000 ")).toBe(1000);
    expect(parseAttributeNumber("2.4")).toBe(2.4);
    expect(parseAttributeNumber("2.4 GHz")).toBeNull();
    expect(parseAttributeNumber("1e3")).toBeNull();
  });

  it("keys facet rows the way the projection stores them", () => {
    expect(normalizeAttributeValue("  Intel Core i7 ")).toBe("intel core i7");
    expect(attributeFacetValueKey({ type: "text", value: " IPS ", valueId: null, valueNumber: null })).toBe("ips");
    expect(attributeFacetValueKey({ type: "enum", value: "ASUS", valueId: "atv_1", valueNumber: null })).toBe("atv_1");
    expect(attributeFacetValueKey({ type: "number", value: "16 GB", valueId: null, valueNumber: 16 })).toBe("16");
    expect(attributeFacetValueKey({ type: "boolean", value: "Yes", valueId: null, valueNumber: 1 })).toBe("1");
    expect(optionFacetKey(" Screen Size ")).toBe("option.screen-size");
  });
});
