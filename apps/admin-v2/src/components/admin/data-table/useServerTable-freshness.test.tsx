// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import type { ColumnDef } from "./table-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTENT_PREFETCH_MOUNT_GRACE_MS,
  useServerTable,
} from "./useServerTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RowData {
  id: string;
}

const QUERY_KEY = ["server-table", "freshness"] as const;
const EMPTY_COLUMNS: ColumnDef<RowData, unknown>[] = [];

function createListQueryOptions(
  queryFn: () => Promise<{ items: RowData[] }>,
  staleTime: number,
) {
  return queryOptions({
    queryKey: QUERY_KEY,
    queryFn,
    staleTime,
  });
}

function ServerTableHarness({
  queryFn,
  staleTime,
}: {
  queryFn: () => Promise<{ items: RowData[] }>;
  staleTime: number;
}) {
  useServerTable<RowData>({
    columns: EMPTY_COLUMNS,
    queryOptions: createListQueryOptions(queryFn, staleTime),
    dataSelector: (raw) => ({
      data: (raw as { items: RowData[] }).items,
      pagination: {
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      },
    }),
    currentPage: 1,
    currentLimit: 20,
    onPaginationChange: () => undefined,
    onSortingChange: () => undefined,
  });

  return null;
}

describe("useServerTable mount freshness", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function prefetchAndMount({
    queryFn,
    staleTime,
    invalidate = false,
  }: {
    queryFn: () => Promise<{ items: RowData[] }>;
    staleTime: number;
    invalidate?: boolean;
  }) {
    const options = createListQueryOptions(queryFn, staleTime);
    await queryClient.prefetchQuery(options);

    if (invalidate) {
      await queryClient.invalidateQueries({
        queryKey: QUERY_KEY,
        refetchType: "none",
      });
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ServerTableHarness queryFn={queryFn} staleTime={staleTime} />
        </QueryClientProvider>,
      );
    });
  }

  it("mounts fresh intent-prefetched rows without a second request", async () => {
    const queryFn = vi.fn(async () => ({ items: [{ id: "fresh" }] }));

    await prefetchAndMount({ queryFn, staleTime: 60_000 });

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  });

  it("refetches prefetched rows that are stale on mount", async () => {
    const queryFn = vi.fn(async () => ({ items: [{ id: "stale" }] }));

    await prefetchAndMount({ queryFn, staleTime: 0 });

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("refetches fresh prefetched rows after mutation-style invalidation", async () => {
    const queryFn = vi.fn(async () => ({ items: [{ id: "invalidated" }] }));

    await prefetchAndMount({
      queryFn,
      staleTime: 60_000,
      invalidate: true,
    });

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("revalidates an ordinary route return after the intent-preload grace period", async () => {
    const queryFn = vi.fn(async () => ({ items: [{ id: "returned" }] }));
    const options = createListQueryOptions(queryFn, 10 * 60_000);
    await queryClient.prefetchQuery(options);
    const prefetchedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(
      prefetchedAt + INTENT_PREFETCH_MOUNT_GRACE_MS + 1,
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ServerTableHarness queryFn={queryFn} staleTime={10 * 60_000} />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });
});
