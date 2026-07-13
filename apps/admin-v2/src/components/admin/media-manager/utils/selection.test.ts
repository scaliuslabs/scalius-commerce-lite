import { describe, expect, it } from "vitest";
import { resolveSelectedMedia, selectAllVisibleMedia, updateMediaSelection } from "./selection";

const visibleIds = ["a", "b", "c", "d", "e"];

describe("media selection semantics", () => {
  it("toggles one visible asset and establishes the range anchor", () => {
    expect(updateMediaSelection({ selectedIds: [], visibleIds, targetId: "c", anchorId: null, extendRange: false }))
      .toEqual({ selectedIds: ["c"], anchorId: "c" });
    expect(updateMediaSelection({ selectedIds: ["c"], visibleIds, targetId: "c", anchorId: "c", extendRange: false }))
      .toEqual({ selectedIds: [], anchorId: "c" });
  });

  it("adds an inclusive Shift range without losing individual selections", () => {
    expect(updateMediaSelection({ selectedIds: ["a", "c"], visibleIds, targetId: "e", anchorId: "c", extendRange: true }))
      .toEqual({ selectedIds: ["a", "c", "d", "e"], anchorId: "c" });
  });

  it("falls back to an individual toggle when the anchor is no longer visible", () => {
    expect(updateMediaSelection({ selectedIds: ["a"], visibleIds, targetId: "d", anchorId: "missing", extendRange: true }))
      .toEqual({ selectedIds: ["a", "d"], anchorId: "d" });
  });

  it("does not let a stale target create a hidden selection", () => {
    expect(updateMediaSelection({ selectedIds: ["a"], visibleIds, targetId: "missing", anchorId: "a", extendRange: true }))
      .toEqual({ selectedIds: ["a"], anchorId: "missing" });
  });

  it("selects each shown asset once only through the explicit command", () => {
    expect(selectAllVisibleMedia(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("resolves a just-uploaded selection before the library refresh completes", () => {
    const visible = [{ id: "a", version: 2 }];
    const uploaded = [{ id: "b", version: 1 }, { id: "a", version: 1 }];

    expect(resolveSelectedMedia(["b", "a", "missing"], visible, uploaded)).toEqual([
      { id: "b", version: 1 },
      { id: "a", version: 2 },
    ]);
  });
});
