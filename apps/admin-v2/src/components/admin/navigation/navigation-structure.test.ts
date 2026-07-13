import { describe, expect, it } from "vitest";
import {
  canIndentNavigationItem,
  getNavigationSubtreeDepth,
} from "./types";

describe("navigation hierarchy limits", () => {
  it("measures the complete subtree before moving an item down a level", () => {
    const branch = {
      id: "branch",
      target: { type: "label" as const },
      labelMode: "custom" as const,
      customLabel: "Branch",
      subMenu: [{
        id: "leaf",
        target: { type: "label" as const },
        labelMode: "custom" as const,
        customLabel: "Leaf",
      }],
    };
    const leaf = {
      id: "leaf",
      target: { type: "label" as const },
      labelMode: "custom" as const,
      customLabel: "Leaf",
    };

    expect(getNavigationSubtreeDepth(branch)).toBe(2);
    expect(canIndentNavigationItem(branch, 0, 3)).toBe(true);
    expect(canIndentNavigationItem(branch, 1, 3)).toBe(false);
    expect(canIndentNavigationItem(leaf, 1, 3)).toBe(true);
    expect(canIndentNavigationItem(leaf, 2, 3)).toBe(false);
  });
});
