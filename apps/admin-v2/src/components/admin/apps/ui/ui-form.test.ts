import { describe, expect, it } from "vitest";
import type { PluginUiInput } from "@scalius/shared/plugins/ui";
import { PLUGIN_BULK_ACTION_MAX_IDS } from "@scalius/shared/plugins/ui";
import { APP_BULK_ACTION_MAX_IDS } from "./AppActions";
import { checkInput, initialInputValue, inputValueToJson } from "./ui-form";

const text = (extra: Partial<Extract<PluginUiInput, { type: "text-field" }>> = {}): PluginUiInput => ({ type: "text-field", name: "name", label: "Name", ...extra });

describe("app form checks", () => {
  it("asks for required values of every kind", () => {
    expect(checkInput(text({ required: true }), "  ")).toEqual({ key: "required" });
    expect(checkInput({ type: "textarea", name: "t", label: "T", required: true }, "")).toEqual({ key: "required" });
    expect(checkInput({ type: "number-field", name: "n", label: "N", required: true }, null)).toEqual({ key: "required" });
    expect(checkInput({ type: "checkbox", name: "c", label: "C", required: true }, false)).toEqual({ key: "required" });
    expect(checkInput({ type: "date-field", name: "d", label: "D", required: true }, null)).toEqual({ key: "required" });
    expect(checkInput({ type: "select", name: "s", label: "S", required: true, options: [{ value: "a", label: "A" }] }, null)).toEqual({ key: "required" });
    // Optional and empty is fine.
    expect(checkInput(text(), "")).toBeNull();
  });

  it("checks lengths and formats of text", () => {
    expect(checkInput(text({ minLength: 3 }), "ab")).toEqual({ key: "tooShort", vars: { min: 3 } });
    expect(checkInput(text({ maxLength: 2 }), "abc")).toEqual({ key: "tooLong", vars: { max: 2 } });
    expect(checkInput(text({ format: "email" }), "not-an-email")).toEqual({ key: "notEmail" });
    expect(checkInput(text({ format: "email" }), "rahim@example.com")).toBeNull();
    expect(checkInput(text({ format: "url" }), "javascript:alert(1)")).toEqual({ key: "notUrl" });
    expect(checkInput(text({ format: "url" }), "https://example.com")).toBeNull();
  });

  it("checks numbers: a number, whole when asked, within bounds", () => {
    const number: PluginUiInput = { type: "number-field", name: "n", label: "N", min: 1, max: 10, integer: true };
    expect(checkInput(number, Number.NaN)).toEqual({ key: "notNumber" });
    expect(checkInput(number, 2.5)).toEqual({ key: "notInteger" });
    expect(checkInput(number, 0)).toEqual({ key: "belowMin", vars: { min: 1 } });
    expect(checkInput(number, 11)).toEqual({ key: "aboveMax", vars: { max: 10 } });
    expect(checkInput(number, 5)).toBeNull();
  });

  it("checks a choice is one of the options", () => {
    const select: PluginUiInput = { type: "select", name: "s", label: "S", options: [{ value: "gold", label: "Gold" }] };
    expect(checkInput(select, "silver")).toEqual({ key: "notOption" });
    expect(checkInput(select, "gold")).toBeNull();
  });

  it("checks real dates inside the range", () => {
    const date: PluginUiInput = { type: "date-field", name: "d", label: "D", min: "2026-02-01", max: "2026-12-31" };
    expect(checkInput(date, "2026-02-30")).toEqual({ key: "notDate" });
    expect(checkInput(date, "2026-01-31")).toEqual({ key: "dateBefore", vars: { min: "2026-02-01" }, dates: true });
    expect(checkInput(date, "2027-01-01")).toEqual({ key: "dateAfter", vars: { max: "2026-12-31" }, dates: true });
    expect(checkInput(date, "2026-06-15")).toBeNull();
  });

  it("starts from the app's values and sends empty choices and dates as null", () => {
    expect(initialInputValue(text({ value: "Rahim" }))).toBe("Rahim");
    expect(initialInputValue({ type: "checkbox", name: "c", label: "C" })).toBe(false);
    expect(inputValueToJson({ type: "select", name: "s", label: "S", options: [{ value: "a", label: "A" }] }, "")).toBeNull();
    expect(inputValueToJson({ type: "date-field", name: "d", label: "D" }, null)).toBeNull();
    expect(inputValueToJson({ type: "number-field", name: "n", label: "N" }, Number.NaN)).toBeNull();
    expect(inputValueToJson({ type: "number-field", name: "n", label: "N" }, 3)).toBe(3);
  });

  it("caps bulk actions where the platform does", () => {
    expect(APP_BULK_ACTION_MAX_IDS).toBe(PLUGIN_BULK_ACTION_MAX_IDS);
  });
});
