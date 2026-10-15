import { describe, expect, it } from "vitest";
import { validateCheckoutAttributes } from "./attributes";
import { NO_CHECKOUT_APP_FUNCTIONS } from "./app-functions";
const apps = { ...NO_CHECKOUT_APP_FUNCTIONS, attributes: [{ appId: "test.notes", fields: [
  { key: "message", label: "Message", type: "text" as const, required: true, maxLength: 10 },
  { key: "count", label: "Count", type: "number" as const, min: 1, max: 4 },
  { key: "date", label: "Date", type: "date" as const },
  { key: "gift", label: "Gift", type: "boolean" as const },
  { key: "size", label: "Size", type: "choice" as const, choices: [{ value: "small", label: "Small" }] },
] }] };
describe("checkout attributes", () => {
  it("drops undeclared keys and permits an incomplete quote", () => {
    expect(validateCheckoutAttributes(apps, { "other.app.unknown": "private" })).toEqual({});
    expect(validateCheckoutAttributes(undefined, { "test.notes.message": "hello" })).toEqual({});
  });
  it("requires declared fields only when placing an order", () => {
    expect(() => validateCheckoutAttributes(apps, {}, true)).toThrow(expect.objectContaining({ code: "attribute_invalid", status: 400 }));
    expect(validateCheckoutAttributes(apps, { "test.notes.message": "hello" }, true)).toEqual({ "test.notes.message": "hello" });
  });
  it.each([["message", "12345678901"], ["count", "Infinity"], ["count", "5"], ["date", "2026-02-30"], ["gift", "yes"], ["size", "large"]])("rejects invalid %s without echoing its value", (key, value) => {
    try { validateCheckoutAttributes(apps, { [`test.notes.${key}`]: value }); throw new Error("accepted"); }
    catch (error) { expect(error).toMatchObject({ code: "attribute_invalid", details: { attribute: `test.notes.${key}` } }); expect((error as Error).message).not.toContain(value); }
  });
  it("retains valid typed values as strings", () => {
    const input = { "test.notes.message": "hello", "test.notes.count": "2.5", "test.notes.date": "2026-02-28", "test.notes.gift": "false", "test.notes.size": "small" };
    expect(validateCheckoutAttributes(apps, input, true)).toEqual(input);
  });
});
