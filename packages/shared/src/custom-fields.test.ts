import { describe, expect, it } from "vitest";

import {
  CUSTOM_FIELD_LIST_MAX_ITEMS,
  CUSTOM_FIELD_OWNER_TYPES,
  CUSTOM_FIELD_SCALAR_TYPES,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_VALUE_MAX_LENGTH,
  MERCHANT_CUSTOM_FIELD_WRITER,
  canWriteCustomFieldNamespace,
  customFieldBoundKind,
  customFieldItemType,
  customFieldReferenceIds,
  customFieldReferenceTarget,
  customFieldValidationsToWire,
  customFieldWireValue,
  isCustomFieldKey,
  isCustomFieldNamespace,
  isCustomFieldType,
  normalizeCustomFieldKey,
  parseCustomFieldValidations,
  parseCustomFieldValue,
  readCustomFieldValidations,
  serializeCustomFieldValidations,
  type CustomFieldType,
  type CustomFieldValidations,
  type CustomFieldCodecContext,
} from "./custom-fields";

const BDT = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 100 } as const;
const USD = { decimalPlaces: 2, currencyCode: "USD" } as const;

function parse(type: CustomFieldType, input: unknown, validations: CustomFieldValidations = {}, context: CustomFieldCodecContext = USD) {
  return parseCustomFieldValue({ type, validations }, input, context);
}

function stored(type: CustomFieldType, input: unknown, validations: CustomFieldValidations = {}, context: CustomFieldCodecContext = USD) {
  const result = parse(type, input, validations, context);
  if (!result.ok) throw new Error(`${type} rejected ${JSON.stringify(input)}: ${result.issue.message}`);
  return result.value;
}

function issue(type: CustomFieldType, input: unknown, validations: CustomFieldValidations = {}, context: CustomFieldCodecContext = USD) {
  const result = parse(type, input, validations, context);
  if (result.ok) throw new Error(`${type} accepted ${JSON.stringify(input)} as ${String(result.value)}`);
  return result.issue;
}

describe("custom field vocabulary", () => {
  it("names the owners and every type with its list form (no list of flags or JSON)", () => {
    expect(CUSTOM_FIELD_OWNER_TYPES).toEqual(["product", "variant", "customer", "order", "category", "collection", "brand", "page"]);
    expect(CUSTOM_FIELD_SCALAR_TYPES).toHaveLength(15);
    expect(CUSTOM_FIELD_TYPES).toHaveLength(28);
    expect(CUSTOM_FIELD_TYPES).not.toContain("list.boolean");
    expect(CUSTOM_FIELD_TYPES).not.toContain("list.json");
    for (const type of CUSTOM_FIELD_TYPES) expect(isCustomFieldType(type)).toBe(true);
    expect(isCustomFieldType("list.list.integer")).toBe(false);
    expect(customFieldItemType("list.money")).toBe("money");
    expect(customFieldReferenceTarget("list.variant_reference")).toBe("variant");
    expect(customFieldReferenceTarget("media_reference")).toBe("media");
    expect(customFieldReferenceTarget("url")).toBeNull();
  });

  it("normalises keys to snake_case and accepts namespaces as custom or plugin ids", () => {
    expect(normalizeCustomFieldKey("Care guide")).toBe("care_guide");
    expect(normalizeCustomFieldKey("  Fabric / Material  ")).toBe("fabric_material");
    expect(normalizeCustomFieldKey("কাপড়")).toBe("kapor");
    expect(normalizeCustomFieldKey("1st colour")).toBe("f_1st_colour");
    expect(normalizeCustomFieldKey("✨")).toBeNull();
    expect(normalizeCustomFieldKey("x".repeat(90))).toHaveLength(64);
    expect(isCustomFieldKey("care_guide")).toBe(true);
    for (const bad of ["Care", "care-guide", "_care", "care__guide", "c", "9lives"]) expect(isCustomFieldKey(bad), bad).toBe(false);
    // `custom`, or a plugin id (`vendor.name`).
    for (const good of ["custom", "acme.hello", "a-b.c", "acme.loyalty-points", "9shop.x1"]) expect(isCustomFieldNamespace(good), good).toBe(true);
    for (const bad of ["Custom", "a.b.c", ".a", "a.", "A.b", "loyalty", "a-.b", "a.-b", "a_b.c", "", "custom.", `${"a".repeat(41)}.b`]) {
      expect(isCustomFieldNamespace(bad), bad).toBe(false);
    }
  });

  it("lets the merchant write only `custom` and a plugin only its own namespace", () => {
    expect(canWriteCustomFieldNamespace(MERCHANT_CUSTOM_FIELD_WRITER, "custom")).toBe(true);
    expect(canWriteCustomFieldNamespace(MERCHANT_CUSTOM_FIELD_WRITER, "acme.loyalty")).toBe(false);
    expect(canWriteCustomFieldNamespace({ kind: "plugin", pluginId: "acme.loyalty" }, "acme.loyalty")).toBe(true);
    expect(canWriteCustomFieldNamespace({ kind: "plugin", pluginId: "acme.loyalty" }, "acme.hello")).toBe(false);
    expect(canWriteCustomFieldNamespace({ kind: "plugin", pluginId: "acme.loyalty" }, "custom")).toBe(false);
    expect(canWriteCustomFieldNamespace({ kind: "plugin", pluginId: "custom" }, "custom")).toBe(false);
    expect(canWriteCustomFieldNamespace({ kind: "plugin", pluginId: "A.b" }, "A.b")).toBe(false);
  });
});

describe("custom field value codec", () => {
  it.each<[CustomFieldType, unknown, string]>([
    ["single_line_text", "  Hand wash cold  ", "Hand wash cold"],
    ["multi_line_text", "Line one\r\nLine two\r\n", "Line one\nLine two"],
    ["integer", 42, "42"],
    ["integer", " -7 ", "-7"],
    ["integer", "-0", "0"],
    ["decimal", "0012.500", "12.5"],
    ["decimal", -3.25, "-3.25"],
    ["decimal", "-0.0", "0"],
    ["decimal", "123456789012345678.123456789", "123456789012345678.123456789"],
    ["boolean", true, "true"],
    ["boolean", "false", "false"],
    ["date", "2026-02-28", "2026-02-28"],
    ["date_time", "2026-10-02T10:00:00+06:00", "2026-10-02T04:00:00Z"],
    ["date_time", "2026-10-02T04:00Z", "2026-10-02T04:00:00Z"],
    ["date_time", "2026-10-02T04:00:00.250Z", "2026-10-02T04:00:00.250Z"],
    ["url", "https://Example.com", "https://example.com/"],
    ["url", "/pages/size-guide", "/pages/size-guide"],
    ["url", "mailto:help@example.com", "mailto:help@example.com"],
    ["color", "#ABC", "#aabbcc"],
    ["color", "#FF0000", "#ff0000"],
    ["json", { a: [1, true, null], b: "x" }, '{"a":[1,true,null],"b":"x"}'],
    ["json", false, "false"],
    ["product_reference", " prod_123 ", "prod_123"],
    ["list.single_line_text", ["S", " M "], '["S","M"]'],
    ["list.integer", [1, "2"], '["1","2"]'],
    ["list.color", ["#fff"], '["#ffffff"]'],
    ["list.variant_reference", ["var_a", "var_b"], '["var_a","var_b"]'],
  ])("%s stores %j as %s", (type, input, expected) => {
    expect(stored(type, input)).toBe(expected);
  });

  it.each<[CustomFieldType, unknown]>([
    ["single_line_text", "two\nlines"],
    ["single_line_text", 12],
    ["single_line_text", "bell\u0007"],
    ["single_line_text", "x".repeat(1001)],
    ["multi_line_text", "x".repeat(20_001)],
    ["integer", 1.5],
    ["integer", "12abc"],
    ["integer", Number.MAX_SAFE_INTEGER + 2],
    ["decimal", "1e5"],
    ["decimal", 1e21],
    ["decimal", "1.1234567891"],
    ["decimal", "1234567890123456789"],
    ["boolean", "yes"],
    ["boolean", 1],
    ["date", "2026-02-30"],
    ["date", "2026-2-3"],
    ["date_time", "2026-10-02T10:00:00"],
    ["date_time", "2026-13-02T10:00:00Z"],
    ["url", "javascript:alert(1)"],
    ["url", "//evil.example"],
    ["url", "https://user:pass@example.com"],
    ["url", "https://example.com/a b"],
    ["url", "ftp://example.com"],
    ["color", "red"],
    ["color", "#12345"],
    ["json", { bad: Number.NaN }],
    ["json", { when: new Date() }],
    ["product_reference", "prod 1"],
    ["list.integer", 5],
    ["list.integer", [1, "x"]],
    ["list.single_line_text", ["a", ""]],
  ])("%s rejects %j", (type, input) => {
    expect(issue(type, input).code).toMatch(/invalid|too_long/);
  });

  it("treats null, blank text and an empty list as clearing the value", () => {
    for (const empty of [null, undefined, "", "   ", []]) {
      expect(parse("single_line_text", empty)).toEqual({ ok: true, value: null });
      expect(parse("list.integer", empty)).toEqual({ ok: true, value: null });
    }
    // false is a value, not a clear.
    expect(stored("boolean", false)).toBe("false");
  });

  it("stores money as integer minor units and shows it in decimal major units", () => {
    expect(stored("money", 12.5)).toBe("1250");
    expect(stored("money", "0.10")).toBe("10");
    expect(stored("list.money", [1, "2.25"])).toBe('["100","225"]');
    expect(customFieldWireValue("money", "1250", USD)).toBe(12.5);
    expect(customFieldWireValue("list.money", '["100","225"]', USD)).toEqual([1, 2.25]);
    // Never rounded, never negative.
    expect(issue("money", "1.255").code).toBe("invalid");
    expect(issue("money", -1).code).toBe("invalid");
    // A BDT store's default increment: taka amounts are whole numbers.
    expect(stored("money", 120, {}, BDT)).toBe("12000");
    expect(issue("money", 12.5, {}, BDT)).toMatchObject({ code: "whole_amount", message: "Taka amounts are whole numbers." });
    // A merchant who prices in paisa stores paisa; reads never re-check the increment.
    expect(stored("money", 12.5, {}, { ...BDT, priceIncrementMinor: 1 })).toBe("1250");
    expect(customFieldWireValue("money", "1250", { decimalPlaces: 2, currencyCode: "BDT" })).toBe(12.5);
    // A zero-decimal currency stores whole units.
    expect(stored("money", 500, {}, { decimalPlaces: 0, currencyCode: "JPY" })).toBe("500");
  });

  it("round-trips every type through the wire form", () => {
    const samples: Array<[CustomFieldType, unknown, unknown]> = [
      ["single_line_text", "Cotton", "Cotton"],
      ["integer", "7", 7],
      ["decimal", 2.5, "2.5"],
      ["boolean", "true", true],
      ["json", [1, { a: 2 }], [1, { a: 2 }]],
      ["date_time", "2026-10-02T10:00:00+06:00", "2026-10-02T04:00:00Z"],
      ["list.decimal", ["1.10", 2], ["1.1", "2"]],
      ["list.date", ["2026-01-01"], ["2026-01-01"]],
    ];
    for (const [type, input, wire] of samples) {
      const value = stored(type, input);
      expect(customFieldWireValue(type, value!, USD), type).toEqual(wire);
      expect(stored(type, customFieldWireValue(type, value!, USD)), type).toBe(value);
    }
  });

  it("never guesses at stored text that is not canonical for the type", () => {
    expect(customFieldWireValue("integer", "1.5", USD)).toBeNull();
    expect(customFieldWireValue("color", "#ABC", USD)).toBeNull();
    expect(customFieldWireValue("money", "12.5", USD)).toBeNull();
    expect(customFieldWireValue("list.integer", "not json", USD)).toBeNull();
    expect(customFieldWireValue("list.integer", '[1,2]', USD)).toBeNull();
    expect(customFieldWireValue("json", "{", USD)).toBeNull();
  });

  it("bounds lists and the stored size", () => {
    expect(issue("list.integer", Array.from({ length: CUSTOM_FIELD_LIST_MAX_ITEMS + 1 }, () => 1)).code).toBe("too_many_items");
    const big = Array.from({ length: 4 }, () => "x".repeat(20_000));
    expect(issue("list.multi_line_text", big).code).toBe("too_long");
    expect(CUSTOM_FIELD_VALUE_MAX_LENGTH).toBe(65_536);
    expect(issue("list.integer", [1, "x"]).index).toBe(1);
  });

  it("lists the ids a reference value names", () => {
    expect(customFieldReferenceIds("product_reference", "prod_1")).toEqual(["prod_1"]);
    expect(customFieldReferenceIds("list.collection_reference", '["col_1","col_2"]')).toEqual(["col_1", "col_2"]);
    expect(customFieldReferenceIds("single_line_text", "prod_1")).toEqual([]);
  });
});

describe("custom field validations", () => {
  it("bounds text length, numbers, money, dates and date-times", () => {
    const length = { min: "2", max: "4" };
    expect(issue("single_line_text", "a", length)).toMatchObject({ code: "too_short", limit: 2 });
    expect(issue("single_line_text", "abcde", length)).toMatchObject({ code: "too_long", limit: 4 });
    expect(stored("single_line_text", "abc", length)).toBe("abc");
    expect(issue("integer", 11, { max: "10" })).toMatchObject({ code: "too_large", limit: 10 });
    expect(issue("decimal", "0.09", { min: "0.1" })).toMatchObject({ code: "too_small", limit: "0.1" });
    expect(stored("decimal", "100000000000000000.5", { min: "99999999999999999.9" })).toBe("100000000000000000.5");
    expect(issue("money", 4.99, { min: "500" })).toMatchObject({ code: "too_small", limit: 5 });
    expect(issue("date", "2025-12-31", { min: "2026-01-01" }).code).toBe("too_small");
    expect(issue("date_time", "2026-01-01T00:00:01Z", { max: "2026-01-01T00:00:00.500Z" }).code).toBe("too_large");
    expect(issue("list.integer", [1, 20], { max: "10" })).toMatchObject({ code: "too_large", index: 1 });
  });

  it("matches a pattern against the whole value and restricts to choices", () => {
    expect(stored("single_line_text", "AB-12", { regex: "[A-Z]{2}-\\d+" })).toBe("AB-12");
    expect(issue("single_line_text", "xAB-12", { regex: "[A-Z]{2}-\\d+" }).code).toBe("pattern");
    expect(stored("list.single_line_text", ["S", "M"], { choices: ["S", "M", "L"] })).toBe('["S","M"]');
    expect(issue("single_line_text", "XL", { choices: ["S", "M", "L"] }).code).toBe("not_a_choice");
  });

  it("parses wire validations per type, money bounds from major units", () => {
    const parsed = parseCustomFieldValidations("money", { min: 5, max: "100.50" }, USD);
    expect(parsed).toEqual({ ok: true, value: { min: "500", max: "10050" } });
    if (!parsed.ok) throw new Error("unreachable");
    expect(customFieldValidationsToWire("money", parsed.value, USD)).toEqual({ min: 5, max: 100.5, regex: null, choices: null });
    expect(parseCustomFieldValidations("single_line_text", { max: 20, regex: "[a-z]+", choices: ["a", " b "] }, USD))
      .toEqual({ ok: true, value: { max: "20", regex: "[a-z]+", choices: ["a", "b"] } });
    expect(parseCustomFieldValidations("date", { min: "2026-01-01", max: null }, USD)).toEqual({ ok: true, value: { min: "2026-01-01" } });
    expect(parseCustomFieldValidations("boolean", null, USD)).toEqual({ ok: true, value: {} });
    expect(customFieldBoundKind("list.url")).toBe("length");
    expect(customFieldBoundKind("color")).toBeNull();
  });

  it.each<[CustomFieldType, unknown]>([
    ["boolean", { min: 1 }],
    ["color", { max: "#ffffff" }],
    ["integer", { regex: "\\d+" }],
    ["multi_line_text", { choices: ["a"] }],
    ["single_line_text", { regex: "(" }],
    ["single_line_text", { regex: "x".repeat(201) }],
    ["single_line_text", { min: -1 }],
    ["single_line_text", { max: 1001 }],
    ["single_line_text", { choices: ["a", "a"] }],
    ["integer", { min: 5, max: 4 }],
    ["date", { min: "2026-02-30" }],
    ["integer", { unknown: 1 }],
    ["integer", [1]],
  ])("%s refuses validations %j", (type, input) => {
    const result = parseCustomFieldValidations(type, input, USD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid_validation");
  });

  it("serialises validations canonically and reads back only well-formed parts", () => {
    const text = serializeCustomFieldValidations({ choices: ["a"], max: "3", min: "1" });
    expect(text).toBe('{"min":"1","max":"3","choices":["a"]}');
    expect(readCustomFieldValidations(text)).toEqual({ min: "1", max: "3", choices: ["a"] });
    expect(readCustomFieldValidations("not json")).toEqual({});
    expect(readCustomFieldValidations('{"min":1,"choices":[1]}')).toEqual({});
  });
});
