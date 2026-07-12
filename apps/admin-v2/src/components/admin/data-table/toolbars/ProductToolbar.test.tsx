// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductToolbar } from "./ProductToolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ProductToolbar category filter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("uses the searchable selector for merchant-sized category data", async () => {
    await act(async () => root.render(
      <ProductToolbar
        searchValue=""
        onSearchChange={vi.fn()}
        categories={[
          { id: "cat_1", name: "Women clothing" },
          { id: "cat_2", name: "Shoes" },
        ]}
        selectedCategory="all"
        onCategoryChange={vi.fn()}
        selectedCount={0}
        showTrashed={false}
        onBulkDelete={vi.fn()}
        isBulkDeleting={false}
        canBulkDelete={false}
      />,
    ));

    const categoryTrigger = host.querySelector(
      '[role="combobox"][aria-label="Filter products by category"]',
    );
    expect(categoryTrigger).toBeTruthy();
    expect(categoryTrigger?.textContent).toContain("All categories");
    expect(host.querySelector('[role="select"]')).toBeNull();
  });
});
