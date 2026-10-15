import { describe, expect, it } from "vitest";
import { objectTypeDeclarationSchema, objectTypeId, prepareObjectData, objectDataWire } from "./objects";

const context = { decimalPlaces: 2, currencyCode: "USD" };
const declaration = (fields: unknown[], extra: Record<string, unknown> = {}) => objectTypeDeclarationSchema.parse({ name: "Records", fields, ...extra });

describe("object contract", () => {
  it("accepts one-letter field keys and validates index fields", () => {
    expect(declaration([{ key: "x", name: "X", type: "integer" }], { indexes: ["x"] }).indexes).toEqual(["x"]);
    expect(() => declaration([{ key: "data", name: "Data", type: "json" }], { indexes: ["data"] })).toThrow();
    expect(() => declaration([{ key: "data", name: "Data", type: "integer" }], { indexes: ["missing"] })).toThrow();
    expect(() => declaration([{ key: "x", name: "X", type: "integer" }], { indexes: ["x", "x"] })).toThrow();
  });
  it("requires object reference targets and preserves the complete app namespace", () => {
    expect(() => declaration([{ key: "target", name: "Target", type: "object_reference" }])).toThrow();
    expect(declaration([{ key: "target", name: "Target", type: "object_reference", to: "acme.app.records" }]).fields[0]?.to).toBe("acme.app.records");
    expect(objectTypeId("acme.app", "records")).toBe("oty_acme.app.records");
  });
  it("enforces typed fields and required values, allowing incomplete drafts", () => {
    const schema = declaration([{ key: "count", name: "Count", type: "integer", required: true, validations: { min: 2 } }]);
    expect(prepareObjectData(schema, {}, context).ok).toBe(false);
    expect(prepareObjectData(schema, {}, context, "draft")).toEqual({ ok: true, data: {} });
    expect(prepareObjectData(schema, { count: 1 }, context).ok).toBe(false);
    expect(prepareObjectData(schema, { count: 2, unknown: true }, context).ok).toBe(false);
    expect(prepareObjectData(schema, { count: 2 }, context)).toEqual({ ok: true, data: { count: 2 } });
  });
  it("stores money as minor integers and restores wire units once", () => {
    const schema = declaration([{ key: "price", name: "Price", type: "money" }, { key: "prices", name: "Prices", type: "list.money" }]);
    const prepared = prepareObjectData(schema, { price: "12.50", prices: ["1.25", "2.50"] }, context);
    expect(prepared).toEqual({ ok: true, data: { price: 1250, prices: [125, 250] } });
    if (prepared.ok) expect(objectDataWire(schema, prepared.data, context)).toEqual({ price: 12.5, prices: [1.25, 2.5] });
  });
});
