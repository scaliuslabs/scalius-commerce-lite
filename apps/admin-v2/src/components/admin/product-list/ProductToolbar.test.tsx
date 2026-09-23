// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import { ProductToolbar } from "./ProductToolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProductToolbar", () => {
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

  async function render(props: { selectedCount: number; canBulkDelete: boolean }) {
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
        sortValue="updatedAt:desc"
        onSortChange={vi.fn()}
        showTrashed={false}
        onBulkDelete={vi.fn()}
        isBulkDeleting={false}
        {...props}
      />,
    ));
  }

  const bulkTrashButton = () =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === translate(resourceMessages, "moveToTrash"),
    );

  it("puts the searchable category filter and the sort in the search row", async () => {
    await render({ selectedCount: 0, canBulkDelete: false });

    const categoryTrigger = host.querySelector(
      `[role="combobox"][aria-label="${translate(productMessages, "filterCategory")}"]`,
    );
    expect(categoryTrigger?.textContent).toContain(translate(productMessages, "allCategories"));
    expect(host.querySelector(`[aria-label="${translate(productMessages, "sortBy")}"]`)).toBeTruthy();
  });

  it("shows the bulk action only to people allowed to use it", async () => {
    await render({ selectedCount: 2, canBulkDelete: false });
    expect(bulkTrashButton()).toBeUndefined();

    await render({ selectedCount: 2, canBulkDelete: true });
    expect(bulkTrashButton()).toBeTruthy();
  });
});
