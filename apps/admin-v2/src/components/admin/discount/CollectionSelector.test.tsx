// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCollections: vi.fn(),
  getCollectionsByIds: vi.fn(),
}));

vi.mock("~/lib/api-functions/collections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api-functions/collections")>()),
  getCollections: mocks.getCollections,
  getCollectionsByIds: mocks.getCollectionsByIds,
}));

import { CollectionSelector } from "./CollectionSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function collection(id: number) {
  return {
    id: `collection_${id}`,
    name: `Collection ${id}`,
    presentation: id % 2 === 0 ? "grid" : "carousel",
  };
}

describe("CollectionSelector", () => {
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
    mocks.getCollections.mockImplementation(
      ({ data }: { data: { page: number } }) => Promise.resolve(
        data.page === 2
          ? {
              collections: [collection(11)],
              pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
            }
          : {
              collections: Array.from({ length: 10 }, (_, index) => collection(index + 1)),
              pagination: { page: 1, limit: 10, total: 11, totalPages: 2 },
            },
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("retains the first page when loading more collections", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <CollectionSelector selectedCollections={[]} onChange={vi.fn()} />
      </QueryClientProvider>,
    ));

    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error("Expected collection picker trigger");
    await act(async () => trigger.click());

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Collection 1");
      expect(document.body.textContent).toContain("Load more (10 of 11)");
    });

    const loadMore = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Load more"));
    if (!loadMore) throw new Error("Expected load-more action");
    await act(async () => loadMore.click());

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Collection 1");
      expect(document.body.textContent).toContain("Collection 11");
    });
    expect(mocks.getCollections).toHaveBeenCalledTimes(2);
    expect(mocks.getCollections).toHaveBeenNthCalledWith(1, {
      data: { page: 1, limit: 10, search: undefined },
    });
    expect(mocks.getCollections).toHaveBeenNthCalledWith(2, {
      data: { page: 2, limit: 10, search: undefined },
    });
    expect(trigger.className).toContain("h-11");
    expect(loadMore.className).toContain("h-11");
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="Search collections"]')
        ?.className,
    ).toContain("h-11");
  });

  it("starts a fresh first page for a debounced search", async () => {
    mocks.getCollections.mockImplementation(
      ({ data }: { data: { page: number; search?: string } }) => Promise.resolve(
        data.search === "spring"
          ? {
              collections: [{ ...collection(20), name: "Spring collection" }],
              pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }
          : {
              collections: [collection(1)],
              pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
            },
      ),
    );

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <CollectionSelector selectedCollections={[]} onChange={vi.fn()} />
      </QueryClientProvider>,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error("Expected collection picker trigger");
    await act(async () => trigger.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Collection 1"));

    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search collections"]',
    );
    if (!input) throw new Error("Expected collection search input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "spring");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Searching collections...");
    await vi.waitFor(
      () => expect(document.body.textContent).toContain("Spring collection"),
      { timeout: 1_000 },
    );
    expect(document.body.textContent).not.toContain("Collection 1");
    expect(mocks.getCollections).toHaveBeenLastCalledWith({
      data: { page: 1, limit: 10, search: "spring" },
    });
  });

  it("offers a mobile-sized retry after an initial failure", async () => {
    mocks.getCollections
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        collections: [collection(1)],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      });

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <CollectionSelector selectedCollections={[]} onChange={vi.fn()} />
      </QueryClientProvider>,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error("Expected collection picker trigger");
    await act(async () => trigger.click());

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Collections could not be loaded.");
    });
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Retry");
    if (!retry) throw new Error("Expected retry action");
    expect(retry.className).toContain("h-11");
    await act(async () => retry.click());

    await vi.waitFor(() => expect(document.body.textContent).toContain("Collection 1"));
    expect(mocks.getCollections).toHaveBeenCalledTimes(2);
  });
});
