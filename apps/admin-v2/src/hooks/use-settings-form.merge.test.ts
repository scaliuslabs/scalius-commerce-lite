import { describe, expect, it } from "vitest";
import { mergeUneditedFields } from "./use-settings-form";

describe("mergeUneditedFields (reload and keep my edits)", () => {
  it("keeps the other save's change beside my edit inside one nested object", () => {
    const base = { name: "Shop", checkout: { guest: true, note: "" } };
    const mine = { name: "Shop", checkout: { guest: false, note: "" } };
    const theirs = { name: "Shop", checkout: { guest: true, note: "Thanks!" } };
    expect(mergeUneditedFields(mine, base, theirs)).toEqual({ name: "Shop", checkout: { guest: false, note: "Thanks!" } });
  });

  it("keeps my edit where both changed the same field, and theirs elsewhere", () => {
    const base = { a: 1, b: { x: 1 }, list: [1] };
    const mine = { a: 2, b: { x: 3 }, list: [1, 2] };
    const theirs = { a: 5, b: { x: 4 }, list: [9] };
    expect(mergeUneditedFields(mine, base, theirs)).toEqual({ a: 2, b: { x: 3 }, list: [1, 2] });
    expect(mergeUneditedFields(base, base, theirs)).toEqual(theirs);
  });
});
