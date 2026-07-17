import { describe, expect, it } from "vitest";

import { getAddNavigationItemsLabel } from "./add-nav-item-dialog-model";

describe("navigation picker action copy", () => {
  it("keeps the idle and single-resource action concise", () => {
    expect(getAddNavigationItemsLabel(0)).toBe("Add item");
    expect(getAddNavigationItemsLabel(1)).toBe("Add item");
  });

  it("states the exact batch size for every multi-resource picker", () => {
    expect(getAddNavigationItemsLabel(2)).toBe("Add 2 items");
    expect(getAddNavigationItemsLabel(18)).toBe("Add 18 items");
  });
});
