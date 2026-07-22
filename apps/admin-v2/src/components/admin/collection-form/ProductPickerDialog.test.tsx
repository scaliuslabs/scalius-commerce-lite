// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const getCollectionProductOptions = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api-functions/collections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api-functions/collections")>()),
  getCollectionProductOptions,
}));

import { ProductPickerDialog } from "./ProductPickerDialog";
import type { Product } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function product(id: number) {
  return {
    id: `prod_${id}`,
    name: `Product ${id}`,
    price: 100 + id,
    categoryId: "cat_test",
    categoryName: "Test category",
    isActive: id % 2 === 1,
    primaryImage: id === 2 ? "/products/product-2.webp" : null,
  };
}

function buttonWithText(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Expected button labeled ${label}`);
  return button;
}

function dialogButtonWithText(label: string): HTMLButtonElement {
  const dialog = document.body.querySelector('[role="dialog"]');
  const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Expected dialog button labeled ${label}`);
  return button;
}

async function waitForUi(assertion: () => void, timeout = 1_000) {
  await act(async () => {
    await vi.waitFor(assertion, { timeout });
  });
}

describe("ProductPickerDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    getCollectionProductOptions.mockImplementation(
      ({ data }: { data: { page: number; search?: string } }) => {
        if (data.search === "missing") {
          return Promise.resolve({
            products: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
          });
        }
        return Promise.resolve(data.page === 2
          ? {
              products: [product(21)],
              pagination: { page: 2, limit: 20, total: 21, totalPages: 2 },
            }
          : {
              products: Array.from({ length: 20 }, (_, index) => product(index + 1)),
              pagination: { page: 1, limit: 20, total: 21, totalPages: 2 },
            });
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPicker(props: {
    selectedProductIds?: string[];
    onAddProducts?: Mock<(products: Product[]) => void>;
    maxProducts?: number;
  } = {}) {
    const onAddProducts = props.onAddProducts ?? vi.fn<(products: Product[]) => void>();
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <ProductPickerDialog
          selectedProductIds={props.selectedProductIds ?? []}
          onAddProducts={onAddProducts}
          maxProducts={props.maxProducts}
        />
      </QueryClientProvider>,
    ));
    await act(async () => buttonWithText("Add products").click());
    await waitForUi(() => {
      expect(document.body.textContent).toContain("Product 1");
    });
    return onAddProducts;
  }

  it("stages multiple products across pages and adds them once", async () => {
    const onAddProducts = await renderPicker({ selectedProductIds: ["prod_1"] });

    const existing = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Product 1, already added"]',
    );
    expect(existing?.disabled).toBe(true);
    expect(existing?.getAttribute("aria-checked")).toBe("true");

    const productTwo = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Product 2"]',
    );
    if (!productTwo) throw new Error("Expected first-page product");
    await act(async () => productTwo.click());
    expect(productTwo.getAttribute("aria-checked")).toBe("true");
    expect(document.body.querySelector('img[src*="product-2.webp"]')).not.toBeNull();

    await act(async () => dialogButtonWithText("Load more (20 of 21)").click());
    await waitForUi(() => {
      expect(document.body.textContent).toContain("Product 21");
    });
    const productTwentyOne = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Product 21"]',
    );
    if (!productTwentyOne) throw new Error("Expected second-page product");
    await act(async () => productTwentyOne.click());

    await act(async () => dialogButtonWithText("Add 2 products").click());

    expect(onAddProducts).toHaveBeenCalledTimes(1);
    expect(onAddProducts.mock.calls[0]?.[0].map((item: { id: string }) => item.id))
      .toEqual(["prod_2", "prod_21"]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("discards staged products on cancel and starts clean when reopened", async () => {
    const onAddProducts = await renderPicker();
    const productOne = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Product 1"]',
    );
    if (!productOne) throw new Error("Expected product option");
    await act(async () => productOne.click());
    expect(document.body.textContent).toContain("1 selected");

    await act(async () => dialogButtonWithText("Cancel").click());
    expect(onAddProducts).not.toHaveBeenCalled();

    await act(async () => buttonWithText("Add products").click());
    await waitForUi(() => {
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Select Product 1"]',
      )?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(dialogButtonWithText("Add products").disabled).toBe(true);
  });

  it("enforces the remaining collection capacity without trapping deselection", async () => {
    const existingIds = Array.from({ length: 89 }, (_, index) => `prod_existing_${index}`);
    await renderPicker({ selectedProductIds: existingIds, maxProducts: 90 });

    const first = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Product 1"]',
    );
    const second = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Product 2"]',
    );
    if (!first || !second) throw new Error("Expected product options");
    await act(async () => first.click());
    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(true);

    await act(async () => first.click());
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(second.disabled).toBe(false);
    expect(dialogButtonWithText("Add products").disabled).toBe(true);
  });

  it("starts a fresh debounced search and exposes compact mobile controls", async () => {
    await renderPicker();
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search products"]',
    );
    if (!search) throw new Error("Expected product search");
    expect(search.className).toContain("h-11");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(search, "missing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Searching products...");
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
    });
    await waitForUi(
      () => expect(document.body.textContent).toContain("No products found."),
    );
    expect(getCollectionProductOptions).toHaveBeenLastCalledWith({
      data: {
        page: 1,
        limit: 20,
        search: "missing",
        categoryIds: [],
        selectedProductIds: [],
      },
    });
    expect(dialogButtonWithText("Cancel").className).toContain("h-11");
  });

  it("offers a mobile-sized retry when the initial query fails", async () => {
    getCollectionProductOptions
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        products: [product(1)],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <ProductPickerDialog selectedProductIds={[]} onAddProducts={vi.fn()} />
      </QueryClientProvider>,
    ));
    await act(async () => buttonWithText("Add products").click());

    await waitForUi(() => {
      expect(document.body.textContent).toContain("Products could not be loaded.");
    });
    const retry = dialogButtonWithText("Retry");
    expect(retry.className).toContain("h-11");
    await act(async () => retry.click());
    await waitForUi(() => {
      expect(document.body.textContent).toContain("Product 1");
    });
  });
});
