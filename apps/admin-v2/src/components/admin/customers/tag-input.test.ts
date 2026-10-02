import { describe, expect, it } from "vitest";
import { addTypedTags, sameTags } from "./tag-input";

describe("typed customer tags", () => {
  it("normalises each part as stored and skips duplicates", () => {
    expect(addTypedTags(["vip"], "  Big   Spender , VIP,eid ", 50)).toEqual({
      tags: ["vip", "big spender", "eid"],
      invalid: [],
      overflow: false,
    });
    expect(addTypedTags([], ", ,", 50)).toEqual({ tags: [], invalid: [], overflow: false });
  });

  it("reports parts that are not a tag and stops at the limit", () => {
    const long = "x".repeat(41);
    expect(addTypedTags([], `ok, ${long}`, 50)).toEqual({ tags: ["ok"], invalid: [long], overflow: false });
    expect(addTypedTags(["a", "b"], "c, d", 3)).toEqual({ tags: ["a", "b", "c"], invalid: [], overflow: true });
  });

  it("compares tag lists in any order", () => {
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameTags(["a"], ["a", "b"])).toBe(false);
  });
});
