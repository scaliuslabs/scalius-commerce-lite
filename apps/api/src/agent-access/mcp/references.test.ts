import { describe, expect, it } from "vitest";
import { containsStepReference, readJsonPointer, resolveStepReferences } from "./references";

describe("bounded batch references", () => {
  it("resolves earlier bounded results through RFC 6901 pointers", () => {
    const completed = new Map([["one", { result: { data: { id: "prod_1" } } }]]);
    expect(resolveStepReferences({ body: { productId: { $step: "one", pointer: "/result/data/id" } } }, completed))
      .toEqual({ body: { productId: "prod_1" } });
  });

  it("rejects future references, poison keys, excess count, depth, and expansion", () => {
    expect(() => resolveStepReferences({ $step: "future" }, new Map())).toThrow("earlier step");
    expect(() => readJsonPointer({ constructor: "bad" }, "/constructor")).toThrow("forbidden");
    const tooMany = Array.from({ length: 101 }, () => ({ $step: "one" }));
    expect(() => resolveStepReferences(tooMany, new Map([["one", 1]]))).toThrow("exceeds 100");
    let deep: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) deep = { next: deep };
    expect(() => resolveStepReferences(deep, new Map())).toThrow("32 levels");
    expect(() => containsStepReference(deep)).toThrow("32 levels");
    const large = "x".repeat(600_000);
    expect(() => resolveStepReferences(
      { a: { $step: "one" }, b: { $step: "one" } },
      new Map([["one", large]]),
    )).toThrow("1 MiB");
  });
});
