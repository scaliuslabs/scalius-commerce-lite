// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaFiles } from "./useMediaFiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchFiles: vi.fn() }));
vi.mock("../api", () => ({ MediaApiClient: api }));

type HookValue = ReturnType<typeof useMediaFiles>;
let latest: HookValue;

function Harness() {
  latest = useMediaFiles(false);
  return null;
}

describe("useMediaFiles failure recovery", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    api.fetchFiles.mockReset().mockRejectedValue(new Error("Media API timed out."));
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps an actionable error until a retry succeeds", async () => {
    await act(async () => { await latest.loadFiles(undefined); });
    expect(latest.isLoading).toBe(false);
    expect(latest.files).toEqual([]);
    expect(latest.loadError).toBe("Media API timed out.");

    api.fetchFiles.mockResolvedValue({
      files: [],
      pagination: { limit: 24, hasMore: false, nextCursor: null },
    });
    await act(async () => { await latest.loadFiles(undefined, latest.filters); });

    expect(latest.loadError).toBeNull();
    expect(latest.files).toEqual([]);
  });
});

function files(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `media_${start + index}` })) as HookValue["files"];
}

function page(rows: HookValue["files"], nextCursor: string | null = null) {
  return { files: rows, pagination: { limit: 50, hasMore: nextCursor !== null, nextCursor } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("useMediaFiles bounded page window", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    api.fetchFiles.mockReset();
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("loads 50 at a time, advances to new rows, and retains all loaded metadata", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    expect(api.fetchFiles).toHaveBeenLastCalledWith(undefined, 50, latest.filters);
    api.fetchFiles.mockResolvedValueOnce(page(files(50, 50), "cursor_2"));
    await act(async () => latest.loadMore());
    expect(latest.pageIndex).toBe(1);
    expect(latest.files).toHaveLength(100);
    act(() => latest.setPageIndex(0));
    expect(latest.files).toHaveLength(100);
    expect(api.fetchFiles).toHaveBeenCalledTimes(2);
  });

  it("deduplicates double Next clicks before React commits the loading state", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    const next = deferred<ReturnType<typeof page>>();
    api.fetchFiles.mockReturnValueOnce(next.promise);
    act(() => { latest.loadMore(); latest.loadMore(); });
    expect(api.fetchFiles).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(page(files(50, 50))));
    expect(latest.files).toHaveLength(100);
    expect(latest.pageIndex).toBe(1);
  });

  it("blocks append during replacement and ignores an obsolete response", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    const older = deferred<ReturnType<typeof page>>();
    api.fetchFiles.mockReturnValueOnce(older.promise);
    let oldRequest!: Promise<void>;
    act(() => {
      oldRequest = latest.loadFiles(undefined, { search: "old" });
      latest.loadMore();
    });
    expect(api.fetchFiles).toHaveBeenCalledTimes(2);
    api.fetchFiles.mockResolvedValueOnce(page(files(200, 5)));
    await act(async () => { await latest.loadFiles(undefined, { search: "new" }); });
    await act(async () => { older.resolve(page(files(100, 50), "obsolete")); await oldRequest; });
    expect(latest.files.map((file) => file.id)).toEqual(files(200, 5).map((file) => file.id));
    expect(latest.filters.search).toBe("new");
    expect(latest.nextCursor).toBeNull();
  });

  it("retries a failed append at the same cursor without dropping earlier rows", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    api.fetchFiles.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => latest.loadMore());
    expect(latest.pageIndex).toBe(0);
    expect(latest.files).toHaveLength(50);
    expect(latest.loadError).toBe("Offline");
    api.fetchFiles.mockResolvedValueOnce(page(files(50, 20)));
    await act(async () => latest.retryFiles());
    expect(api.fetchFiles).toHaveBeenLastCalledWith("cursor_1", 50, latest.filters);
    expect(latest.files).toHaveLength(70);
    expect(latest.pageIndex).toBe(1);
    expect(latest.loadError).toBeNull();
  });

  it("preserves the current page on failed replacement and resets on successful retry", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    api.fetchFiles.mockResolvedValueOnce(page(files(50, 50), "cursor_2"));
    await act(async () => latest.loadMore());
    api.fetchFiles.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { await latest.loadFiles(undefined, { search: "shirt" }); });
    expect(latest.pageIndex).toBe(1);
    expect(latest.files).toHaveLength(100);
    act(() => latest.loadMore());
    expect(api.fetchFiles).toHaveBeenCalledTimes(3);
    api.fetchFiles.mockResolvedValueOnce(page(files(300, 50)));
    await act(async () => latest.retryFiles());
    expect(api.fetchFiles).toHaveBeenLastCalledWith(undefined, 50, expect.objectContaining({ search: "shirt" }));
    expect(latest.pageIndex).toBe(0);
    expect(latest.files).toEqual(files(300, 50));
  });

  it("keeps an empty or duplicate cursor page from advancing and clamps shortened lists", async () => {
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_1"));
    await act(async () => { await latest.loadFiles(undefined); });
    api.fetchFiles.mockResolvedValueOnce(page(files(0, 50), "cursor_2"));
    await act(async () => latest.loadMore());
    expect(latest.files).toHaveLength(50);
    expect(latest.pageIndex).toBe(0);
    act(() => { latest.setFiles(files(0, 125)); latest.setPageIndex(2); });
    act(() => latest.setFiles((current) => current.slice(0, 30)));
    expect(latest.pageIndex).toBe(0);
  });
});
