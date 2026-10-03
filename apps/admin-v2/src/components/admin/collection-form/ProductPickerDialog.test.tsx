// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const getCollectionProductOptions = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminCollectionsProductOptions: getCollectionProductOptions,
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { ProductPickerDialog } from "./ProductPickerDialog";
import type { Product } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function product(id: number) {
  return {
    id: `prod_${id}`,
    name: `Product ${id}`,
    priceRange: { from: 100 + id, to: 100 + id, compareAt: null },
    categoryId: "cat_test",
    categoryName: "Test category",
    isActive: id % 2 === 1,
    primaryImage: id === 2 ? "/products/product-2.webp" : null,
    variantCount: id === 1 ? 3 : 0,
    available: id === 3 ? null : 10 + id,
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

function checkbox(name: string): HTMLButtonElement {
  const box = document.body.querySelector<HTMLButtonElement>(
    `[role="dialog"] button[role="checkbox"][aria-label="${name}"]`,
  );
  if (!box) throw new Error(`Expected a checkbox for ${name}`);
  return box;
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
      ({ query: data }: { query: { page: number; search?: string } }) => {
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

  it("opens on the newest products with price and stock or variants", async () => {
    await renderPicker();

    expect(getCollectionProductOptions).toHaveBeenCalledWith({
      query: { page: 1, limit: 20, search: undefined, categoryIds: undefined, selectedProductIds: undefined },
    });
    const rows = Array.from(document.body.querySelectorAll('[role="dialog"] li')).map((row) => row.textContent);
    expect(rows[0]).toContain("৳101 · 3 variants · 11 in stock");
    expect(rows[1]).toContain("৳102 · 12 in stock");
    expect(rows[2]).toContain("৳103 · Stock not tracked");
  });

  it("says the store has no products and links to adding one", async () => {
    getCollectionProductOptions.mockResolvedValue({
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <ProductPickerDialog selectedProductIds={[]} onAddProducts={vi.fn()} />
      </QueryClientProvider>,
    ));
    await act(async () => buttonWithText("Add products").click());

    await waitForUi(() => {
      expect(document.body.textContent).toContain("Your store has no products yet.");
    });
    expect(document.body.querySelector('a[href="/admin/products/new"]')?.textContent).toBe("Add product");
  });

  it("stages multiple products across pages and adds them once", async () => {
    const onAddProducts = await renderPicker({ selectedProductIds: ["prod_1"] });

    const existing = checkbox("Product 1");
    expect(existing?.disabled).toBe(true);
    expect(existing?.getAttribute("aria-checked")).toBe("true");

    const productTwo = checkbox("Product 2");
    await act(async () => productTwo.click());
    expect(productTwo.getAttribute("aria-checked")).toBe("true");
    expect(document.body.querySelector('img[src*="product-2.webp"]')).not.toBeNull();

    await act(async () => dialogButtonWithText("Load more").click());
    await waitForUi(() => {
      expect(document.body.textContent).toContain("Product 21");
    });
    await act(async () => checkbox("Product 21").click());
    expect(document.body.textContent).toContain("2 selected");

    await act(async () => dialogButtonWithText("Add").click());

    expect(onAddProducts).toHaveBeenCalledTimes(1);
    expect(onAddProducts.mock.calls[0]?.[0].map((item: { id: string }) => item.id))
      .toEqual(["prod_2", "prod_21"]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("discards staged products on cancel and starts clean when reopened", async () => {
    const onAddProducts = await renderPicker();
    await act(async () => checkbox("Product 1").click());
    expect(document.body.textContent).toContain("1 selected");

    await act(async () => dialogButtonWithText("Cancel").click());
    expect(onAddProducts).not.toHaveBeenCalled();

    await act(async () => buttonWithText("Add products").click());
    await waitForUi(() => {
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    });
    await waitForUi(() => {
      expect(checkbox("Product 1").getAttribute("aria-checked")).toBe("false");
    });
    expect(dialogButtonWithText("Add").disabled).toBe(true);
  });

  it("enforces the remaining collection capacity without trapping deselection", async () => {
    const existingIds = Array.from({ length: 89 }, (_, index) => `prod_existing_${index}`);
    await renderPicker({ selectedProductIds: existingIds, maxProducts: 90 });

    const first = checkbox("Product 1");
    const second = checkbox("Product 2");
    await act(async () => first.click());
    expect(document.body.textContent).toContain("1 selected · limit reached");
    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(true);

    await act(async () => first.click());
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(second.disabled).toBe(false);
    expect(dialogButtonWithText("Add").disabled).toBe(true);
  });

  it("starts a fresh debounced search", async () => {
    await renderPicker();
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search products"]',
    );
    if (!search) throw new Error("Expected product search");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(search, "missing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Loading products…");
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
    });
    await waitForUi(
      () => expect(document.body.textContent).toContain("No products match “missing”"),
    );
    expect(getCollectionProductOptions).toHaveBeenLastCalledWith({
      query: {
        page: 1,
        limit: 20,
        search: "missing",
        categoryIds: undefined,
        selectedProductIds: undefined,
      },
    });
  });

  it("offers a retry when the initial query fails", async () => {
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
      expect(document.body.textContent).toContain("Couldn't load products.");
    });
    await act(async () => dialogButtonWithText("Try again").click());
    await waitForUi(() => {
      expect(document.body.textContent).toContain("Product 1");
    });
  });
});
