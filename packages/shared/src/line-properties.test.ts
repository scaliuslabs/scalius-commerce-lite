import { describe, expect, it } from "vitest";

import {
  canonicalizeLineProperties,
  CUSTOMIZATION_LIMITS,
  hasRequiredCustomization,
  lineCartKey,
  linePropertiesHash,
  ORDER_LINE_PROPERTIES_MAX_LENGTH,
  parseCustomizationSchema,
  parseStoredCustomizationSchema,
  resolveLineProperties,
  serializeCustomizationSchema,
  serializeOrderLineProperties,
  type CustomizationSchema,
} from "./line-properties";

const designExample = {
  version: 1,
  fields: [
    {
      key: "engraving", label: "Engraving text", type: "text", required: false,
      maxLength: 30, help: "Up to 30 characters", priceMinor: 20_000,
    },
    { key: "wrap", label: "Gift wrap", type: "checkbox", priceMinor: 5_000 },
    {
      key: "size_fit", label: "Fit", type: "select", required: true,
      options: [
        { value: "regular", label: "Regular", priceMinor: 0 },
        { value: "slim", label: "Slim", priceMinor: 10_000 },
      ],
    },
    { key: "note", label: "Instructions", type: "textarea", maxLength: 500 },
  ],
};

function schemaOf(input: unknown): CustomizationSchema {
  const parsed = parseCustomizationSchema(input);
  if (!parsed.ok || !parsed.schema) throw new Error(`invalid test schema: ${JSON.stringify(parsed)}`);
  return parsed.schema;
}

const schema = schemaOf(designExample);

function field(overrides: Record<string, unknown>) {
  return { key: "f", label: "Field", type: "text", ...overrides };
}

function issuesOf(input: unknown, options = {}): string[] {
  const parsed = parseCustomizationSchema(input, options);
  return parsed.ok ? [] : parsed.issues;
}

describe("customization schema (§3.1)", () => {
  it("normalizes the design example with explicit defaults", () => {
    expect(schema.fields.map((item) => item.type)).toEqual(["text", "checkbox", "select", "textarea"]);
    expect(schema.fields[1]).toEqual({
      key: "wrap", label: "Gift wrap", required: false, help: null, type: "checkbox", priceMinor: 5_000,
    });
    expect(schema.fields[3]).toMatchObject({ type: "textarea", maxLength: 500, priceMinor: 0 });
    expect(hasRequiredCustomization(schema)).toBe(true);
  });

  it("treats no schema and a schema without fields as no buyer inputs", () => {
    expect(parseCustomizationSchema(null)).toEqual({ ok: true, schema: null });
    expect(parseCustomizationSchema(undefined)).toEqual({ ok: true, schema: null });
    expect(parseCustomizationSchema({ version: 1, fields: [] })).toEqual({ ok: true, schema: null });
    expect(hasRequiredCustomization(null)).toBe(false);
  });

  it("round-trips through the stored column and refuses malformed JSON", () => {
    expect(parseStoredCustomizationSchema(serializeCustomizationSchema(schema))).toEqual({ ok: true, schema });
    expect(parseStoredCustomizationSchema(null)).toEqual({ ok: true, schema: null });
    expect(parseStoredCustomizationSchema("{not json")).toMatchObject({ ok: false });
  });

  // P7: every documented limit is enforced.
  it.each<[string, unknown, RegExp]>([
    ["more than 10 fields", { version: 1, fields: Array.from({ length: 11 }, (_, index) => field({ key: `f${index}` })) }, /at most 10 entries/],
    ["a bad key", { version: 1, fields: [field({ key: "Bad-Key" })] }, /key must be/],
    ["a key over 40 characters", { version: 1, fields: [field({ key: "k".repeat(41) })] }, /key must be/],
    ["a repeated key", { version: 1, fields: [field({}), field({})] }, /used twice/],
    ["a reserved gift-card key", { version: 1, fields: [field({ key: "_gc_recipient" })] }, /reserved/],
    ["a label over 60 characters", { version: 1, fields: [field({ label: "L".repeat(61) })] }, /label must be at most 60/],
    ["a missing label", { version: 1, fields: [field({ label: "  " })] }, /label is required/],
    ["help over 200 characters", { version: 1, fields: [field({ help: "h".repeat(201) })] }, /help must be at most 200/],
    ["text maxLength over 200", { version: 1, fields: [field({ maxLength: 201 })] }, /maxLength must be a whole number from 1 to 200/],
    ["textarea maxLength over 1000", { version: 1, fields: [field({ type: "textarea", maxLength: 1_001 })] }, /from 1 to 1000/],
    ["a select with 21 options", {
      version: 1,
      fields: [field({
        type: "select",
        options: Array.from({ length: 21 }, (_, index) => ({ value: `v${index}`, label: `V${index}` })),
      })],
    }, /at most 20 choices/],
    ["a select without options", { version: 1, fields: [field({ type: "select", options: [] })] }, /at least one choice/],
    ["a repeated option", {
      version: 1,
      fields: [field({ type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })],
    }, /repeats another choice/],
    ["a negative surcharge", { version: 1, fields: [field({ priceMinor: -1 })] }, /minor units from 0/],
    ["a fractional surcharge", { version: 1, fields: [field({ priceMinor: 1.5 })] }, /minor units from 0/],
    ["an unknown type", { version: 1, fields: [field({ type: "file" })] }, /type must be one of/],
    ["the wrong version", { version: 2, fields: [field({})] }, /version must be 1/],
    ["a field-level select price", {
      version: 1, fields: [field({ type: "select", priceMinor: 100, options: [{ value: "a", label: "A" }] })],
    }, /belongs on each option/],
  ])("refuses %s", (_label, input, expected) => {
    expect(issuesOf(input).join("\n")).toMatch(expected);
  });

  it("enforces a whole-taka surcharge step when the store asks for one", () => {
    expect(issuesOf({ version: 1, fields: [field({ priceMinor: 150 })] }, { priceStepMinor: 100 }).join())
      .toMatch(/multiple of 100/);
    expect(issuesOf({ version: 1, fields: [field({ priceMinor: 200 })] }, { priceStepMinor: 100 })).toEqual([]);
  });

  it("allows reserved keys only for gift-card products", () => {
    expect(parseCustomizationSchema(
      { version: 1, fields: [field({ key: "_gc_recipient" })] },
      { allowReservedKeys: true },
    )).toMatchObject({ ok: true });
  });

  it("bounds the serialized schema at the database CHECK size", () => {
    const wide = {
      version: 1,
      fields: Array.from({ length: 10 }, (_, index) => field({
        key: `field_${index}`,
        type: "select",
        options: Array.from({ length: 20 }, (_, option) => ({
          value: `value_${option}_${"v".repeat(40)}`,
          label: `label ${option}`,
        })),
      })),
    };
    expect(issuesOf(wide).join()).toMatch(new RegExp(`at most ${CUSTOMIZATION_LIMITS.serializedLength} characters`));
  });
});

describe("buyer properties: resolution and pricing (§3.3)", () => {
  it("prices a customised line as the sum of its surcharges and freezes labels", () => {
    const result = resolveLineProperties(schema, [
      { key: "size_fit", value: "slim" },
      { key: "wrap", value: "true" },
      { key: "engraving", value: "  For Nila  " },
    ]);
    expect(result).toEqual({
      ok: true,
      canonical: [
        { key: "engraving", value: "For Nila" },
        { key: "wrap", value: "true" },
        { key: "size_fit", value: "slim" },
      ],
      properties: [
        { key: "engraving", type: "text", label: "Engraving text", value: "For Nila", displayValue: "For Nila", priceMinor: 20_000 },
        { key: "wrap", type: "checkbox", label: "Gift wrap", value: "true", displayValue: "Yes", priceMinor: 5_000 },
        { key: "size_fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", priceMinor: 10_000 },
      ],
      propertiesPriceMinor: 35_000,
    });
  });

  it("drops empty optional fields and reports a missing required one", () => {
    expect(resolveLineProperties(schema, [{ key: "engraving", value: "   " }, { key: "size_fit", value: "regular" }]))
      .toMatchObject({ ok: true, propertiesPriceMinor: 0, canonical: [{ key: "size_fit", value: "regular" }] });
    expect(resolveLineProperties(schema, [{ key: "wrap", value: "true" }])).toEqual({
      ok: false, code: "PROPERTIES_REQUIRED", key: "size_fit", reason: "required",
    });
    expect(resolveLineProperties(schema, undefined)).toMatchObject({ ok: false, code: "PROPERTIES_REQUIRED" });
  });

  it("accepts no properties for a product without inputs, and refuses any it sends", () => {
    expect(resolveLineProperties(null, undefined)).toEqual({ ok: true, canonical: [], properties: [], propertiesPriceMinor: 0 });
    expect(resolveLineProperties(null, [])).toMatchObject({ ok: true });
    expect(resolveLineProperties(null, [{ key: "engraving", value: "x" }])).toMatchObject({ ok: false, code: "PROPERTIES_INVALID" });
  });

  // P7: buyer payload limits.
  it.each<[string, unknown, RegExp]>([
    ["not a list", { key: "size_fit", value: "slim" }, /must be a list/],
    ["more than 10 entries", Array.from({ length: 11 }, () => ({ key: "size_fit", value: "slim" })), /at most 10/],
    ["a non-text value", [{ key: "size_fit", value: 1 }], /text key and a text value/],
    ["an unknown key", [{ key: "colour", value: "red" }, { key: "size_fit", value: "slim" }], /unknown property/],
    ["a repeated key", [{ key: "size_fit", value: "slim" }, { key: "size_fit", value: "regular" }], /sent twice/],
    ["a value over 1000 characters", [{ key: "note", value: "n".repeat(1_001) }, { key: "size_fit", value: "slim" }], /at most 1000/],
    ["text over the field limit", [{ key: "engraving", value: "e".repeat(31) }, { key: "size_fit", value: "slim" }], /at most 30/],
    ["a line break in a one-line field", [{ key: "engraving", value: "a\nb" }, { key: "size_fit", value: "slim" }], /not allowed/],
    ["a control character", [{ key: "note", value: "a\u0007b" }, { key: "size_fit", value: "slim" }], /not allowed/],
    ["a choice not on the list", [{ key: "size_fit", value: "tight" }], /not one of the choices/],
    ["a checkbox that is not \"true\"", [{ key: "wrap", value: "yes" }, { key: "size_fit", value: "slim" }], /ticked box/],
  ])("refuses %s", (_label, input, expected) => {
    const result = resolveLineProperties(schema, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPERTIES_INVALID");
      expect(result.reason).toMatch(expected);
    }
  });

  it("allows line breaks in a textarea", () => {
    expect(resolveLineProperties(schema, [{ key: "note", value: "line one\nline two" }, { key: "size_fit", value: "slim" }]))
      .toMatchObject({ ok: true });
  });

  it("keeps the worst-case snapshot inside the order_items CHECK bound", () => {
    const widest = schemaOf({
      version: 1,
      fields: Array.from({ length: 10 }, (_, index) => ({
        key: `note_${index}`, label: `"${"L".repeat(58)}"`, type: "textarea", maxLength: 1_000, priceMinor: 999_999,
      })),
    });
    const result = resolveLineProperties(widest, widest.fields.map((item) => ({ key: item.key, value: `x${"\"\n".repeat(499)}x` })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializeOrderLineProperties(result.properties)!.length).toBeLessThanOrEqual(ORDER_LINE_PROPERTIES_MAX_LENGTH);
    expect(serializeOrderLineProperties([])).toBeNull();
  });
});

describe("cart line identity (P2)", () => {
  async function keyOf(properties: unknown): Promise<string> {
    return lineCartKey("prod_1", "var_1", await linePropertiesHash(canonicalizeLineProperties(schema, properties)));
  }

  it("gives the same SKU with the same canonical properties one line", async () => {
    const first = await keyOf([{ key: "size_fit", value: "slim" }, { key: "engraving", value: "Nila" }]);
    const reordered = await keyOf([{ key: "engraving", value: " Nila " }, { key: "size_fit", value: "slim" }]);
    const withNoise = await keyOf([
      { key: "engraving", value: "Nila" },
      { key: "size_fit", value: "slim" },
      { key: "wrap", value: "false" },
      { key: "note", value: "   " },
      { key: "unknown", value: "ignored" },
    ]);
    expect(reordered).toBe(first);
    expect(withNoise).toBe(first);
    expect(first).toMatch(/^line:v3:prod_1:variant:var_1:p:[0-9a-f]{16}$/);
  });

  it("gives different properties different lines", async () => {
    const slim = await keyOf([{ key: "size_fit", value: "slim" }]);
    const regular = await keyOf([{ key: "size_fit", value: "regular" }]);
    const wrapped = await keyOf([{ key: "size_fit", value: "slim" }, { key: "wrap", value: "true" }]);
    expect(new Set([slim, regular, wrapped]).size).toBe(3);
  });

  it("normalizes Unicode so the same text typed two ways is one line", async () => {
    const composed = await keyOf([{ key: "engraving", value: "Café" }, { key: "size_fit", value: "slim" }]);
    const decomposed = await keyOf([{ key: "engraving", value: "Café" }, { key: "size_fit", value: "slim" }]);
    expect(decomposed).toBe(composed);
  });

  it("uses \"none\" for lines without properties", async () => {
    expect(await keyOf(undefined)).toBe("line:v3:prod_1:variant:var_1:p:none");
    expect(await linePropertiesHash(canonicalizeLineProperties(null, [{ key: "size_fit", value: "slim" }]))).toBe("none");
  });

  it("agrees with the strict resolver's canonical form", async () => {
    const input = [{ key: "wrap", value: "true" }, { key: "size_fit", value: "slim" }];
    const strict = resolveLineProperties(schema, input);
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    expect(strict.canonical).toEqual(canonicalizeLineProperties(schema, input));
  });
});
