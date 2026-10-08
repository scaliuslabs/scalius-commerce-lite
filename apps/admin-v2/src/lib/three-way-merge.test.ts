import { describe, expect, it } from "vitest";
import { resolveMerge, sameValue, threeWayMerge } from "./three-way-merge";

describe("threeWayMerge", () => {
  const base = { title: "Panjabi", price: 1000, discountAmount: 0, tags: ["eid"], seo: { title: "A", description: "B" } };

  it("combines changes to different fields without asking", () => {
    const theirs = { ...base, title: "Cotton panjabi" };
    const mine = { ...base, tags: ["eid", "summer"] };
    const result = threeWayMerge(base, theirs, mine);
    expect(result.clashes).toEqual([]);
    expect(result.merged).toEqual({ ...base, title: "Cotton panjabi", tags: ["eid", "summer"] });
  });

  it("is not a clash when both made the same change", () => {
    const changed = { ...base, title: "Cotton panjabi" };
    expect(threeWayMerge(base, changed, { ...changed }).clashes).toEqual([]);
  });

  it("asks about a field both changed differently, and keeps the saved value until chosen", () => {
    const theirs = { ...base, title: "Cotton panjabi" };
    const mine = { ...base, title: "Silk panjabi", tags: ["new"] };
    const result = threeWayMerge(base, theirs, mine);
    expect(result.clashes).toEqual([{
      key: "title",
      paths: ["title"],
      base: { title: "Panjabi" },
      theirs: { title: "Cotton panjabi" },
      mine: { title: "Silk panjabi" },
    }]);
    expect(result.merged.title).toBe("Cotton panjabi");
    expect(result.merged.tags).toEqual(["new"]);
    expect(resolveMerge(result, { title: "mine" }).title).toBe("Silk panjabi");
    expect(resolveMerge(result, { title: "theirs" }).title).toBe("Cotton panjabi");
  });

  it("merges nested settings fields one by one", () => {
    const theirs = { ...base, seo: { title: "Theirs", description: "B" } };
    const mine = { ...base, seo: { title: "A", description: "Mine" } };
    const result = threeWayMerge(base, theirs, mine);
    expect(result.clashes).toEqual([]);
    expect(result.merged.seo).toEqual({ title: "Theirs", description: "Mine" });
  });

  it("never mixes coupled fields from two saves", () => {
    const theirs = { ...base, price: 1200 };
    const mine = { ...base, discountAmount: 100 };
    const result = threeWayMerge(base, theirs, mine, { coupled: { pricing: ["price", "discountAmount"] } });
    expect(result.clashes).toHaveLength(1);
    expect(result.clashes[0]).toMatchObject({ key: "pricing", paths: ["discountAmount", "price"] });
    // Until chosen, the saved group stands whole.
    expect(result.merged).toMatchObject({ price: 1200, discountAmount: 0 });
    // Choosing mine takes the whole group from this draft.
    expect(resolveMerge(result, { pricing: "mine" })).toMatchObject({ price: 1000, discountAmount: 100 });
  });

  it("lets a coupled group through when only one side touched it", () => {
    const theirs = { ...base, title: "New" };
    const mine = { ...base, price: 900 };
    const result = threeWayMerge(base, theirs, mine, { coupled: { pricing: ["price", "discountAmount"] } });
    expect(result.clashes).toEqual([]);
    expect(result.merged).toMatchObject({ title: "New", price: 900 });
  });

  it("treats arrays as one value and ignores key order", () => {
    expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    const result = threeWayMerge(base, { ...base, tags: ["a"] }, { ...base, tags: ["b"] });
    expect(result.clashes.map((clash) => clash.key)).toEqual(["tags"]);
  });
  it("asks when one save replaced an object the other edited inside", () => {
    // They edited a.c; I cleared a: the clash is all of a, and their a.c is not lost silently.
    const cleared = threeWayMerge({ a: { c: 1, d: 1 } }, { a: { c: 2, d: 1 } }, { a: null } as { a: { c: number; d: number } | null });
    expect(cleared.clashes.map((clash) => clash.key)).toEqual(["a"]);
    expect(cleared.merged).toEqual({ a: { c: 2, d: 1 } });
    expect(resolveMerge(cleared, { a: "mine" })).toEqual({ a: null });
    // They cleared a; I edited a.c and a.d: one clash for a, never a half object.
    const edited = threeWayMerge({ a: { c: 1, d: 1 } } as { a: { c: number; d: number } | null }, { a: null }, { a: { c: 5, d: 6 } });
    expect(edited.clashes.map((clash) => clash.key)).toEqual(["a"]);
    expect(edited.merged).toEqual({ a: null });
    expect(resolveMerge(edited, { a: "mine" })).toEqual({ a: { c: 5, d: 6 } });
  });

  it("treats a missing field and null as the same empty value", () => {
    const result = threeWayMerge({ title: "A", note: null } as Record<string, unknown>, { title: "B", note: null }, { title: "A" });
    expect(result.clashes).toEqual([]);
    expect(result.mineChanged).toEqual([]);
    expect(result.merged).toEqual({ title: "B", note: null });
  });
});
