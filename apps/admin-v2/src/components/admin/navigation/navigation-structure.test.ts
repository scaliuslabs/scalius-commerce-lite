import { describe, expect, it } from "vitest";
import {
  canIndentNavigationItem,
  getNavigationSubtreeDepth,
} from "./types";

describe("navigation hierarchy limits", () => {
  it("measures the complete subtree before moving an item down a level", () => {
    const branch = {
      id: "branch",
      title: "Branch",
      subMenu: [{ id: "leaf", title: "Leaf" }],
    };

    expect(getNavigationSubtreeDepth(branch)).toBe(2);
    expect(canIndentNavigationItem(branch, 0, 3)).toBe(true);
    expect(canIndentNavigationItem(branch, 1, 3)).toBe(false);
    expect(canIndentNavigationItem({ id: "leaf", title: "Leaf" }, 1, 3)).toBe(true);
    expect(canIndentNavigationItem({ id: "leaf", title: "Leaf" }, 2, 3)).toBe(false);
  });
});
