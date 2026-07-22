// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getNavigationResources = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api-functions/navigation-authority", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/lib/api-functions/navigation-authority")
  >()),
  getNavigationResourcesAuthority: getNavigationResources,
}));

import { NavigationResourcePicker } from "./NavigationResourcePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("NavigationResourcePicker", () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hydrates an unavailable saved resource instead of exposing its internal id", async () => {
    getNavigationResources.mockResolvedValue({
      items: [],
      selected: {
        id: "prod_unavailable",
        name: "Retired running shoe",
        type: "product",
        url: "/products/retired-running-shoe",
        available: false,
      },
      nextCursor: null,
    });

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationResourcePicker
          id="resource"
          type="product"
          value="prod_unavailable"
          fallbackLabel="Old label"
          onValueChange={vi.fn()}
        />
      </QueryClientProvider>,
    ));

    await vi.waitFor(() => {
      expect(host.querySelector("button")?.textContent).toContain(
        "Retired running shoe",
      );
    });
    expect(document.body.textContent).not.toContain("prod_unavailable");

    const trigger = host.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Choose product"]',
    );
    if (!trigger) throw new Error("Expected product resource trigger");
    await act(async () => trigger.click());
    await flushUi();

    expect(document.body.textContent).toContain("Unavailable");
    expect(trigger.className).toContain("h-11");
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Search products"]',
      )?.className,
    ).toContain("h-11");
    expect(getNavigationResources).toHaveBeenCalledWith({
      data: {
        type: "product",
        query: "",
        limit: 20,
        selectedId: "prod_unavailable",
      },
    });
  });

  it("loads resources beyond the first page and selects them", async () => {
    getNavigationResources.mockImplementation(
      ({ data }: { data: { cursor?: string } }) => Promise.resolve(
        data.cursor
          ? {
              items: [{
                id: "prod_021",
                name: "Product 021",
                type: "product",
                url: "/products/product-021",
                available: true,
              }],
              selected: null,
              nextCursor: null,
            }
          : {
              items: [{
                id: "prod_020",
                name: "Product 020",
                type: "product",
                url: "/products/product-020",
                available: true,
              }],
              selected: null,
              nextCursor: "page-two",
            },
      ),
    );
    const onValueChange = vi.fn();

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationResourcePicker
          id="resource"
          type="product"
          value=""
          onValueChange={onValueChange}
        />
      </QueryClientProvider>,
    ));

    const trigger = host.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Choose product"]',
    );
    if (!trigger) throw new Error("Expected product resource trigger");
    await act(async () => trigger.click());

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Product 020");
      expect(document.body.textContent).toContain("Load more");
    });
    const firstOption = document.body.querySelector<HTMLElement>('[role="option"]');
    expect(firstOption?.className).toContain("min-h-11");

    const loadMore = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Load more");
    if (!loadMore) throw new Error("Expected load more button");
    await act(async () => loadMore.click());

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Product 021");
    });
    expect(getNavigationResources).toHaveBeenLastCalledWith({
      data: {
        type: "product",
        query: "",
        limit: 20,
        cursor: "page-two",
      },
    });

    const secondOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.includes("Product 021"));
    if (!secondOption) throw new Error("Expected second-page product");
    await act(async () => secondOption.click());

    expect(onValueChange).toHaveBeenCalledWith("prod_021");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
