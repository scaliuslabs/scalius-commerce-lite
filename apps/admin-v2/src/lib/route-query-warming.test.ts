import { afterEach, describe, expect, it, vi } from "vitest";
import { warmRouteQuery } from "./route-query-warming";

function createQueryClientMock() {
  return {
    ensureQueryData: vi.fn(async () => undefined),
    getQueryData: vi.fn(),
    prefetchQuery: vi.fn(async () => undefined),
  };
}

describe("warmRouteQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("awaits ensureQueryData during SSR so cold HTML has correct primary data", async () => {
    vi.stubGlobal("window", undefined);
    const queryClient = createQueryClientMock();
    const options = { queryKey: ["dashboard", "summary"], queryFn: vi.fn() };

    await warmRouteQuery(queryClient as never, options);

    expect(queryClient.ensureQueryData).toHaveBeenCalledWith(options);
    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
  });

  it("starts a client prefetch without blocking when the query is absent", async () => {
    vi.stubGlobal("window", {});
    const queryClient = createQueryClientMock();
    queryClient.getQueryData.mockReturnValue(undefined);
    const options = { queryKey: ["dashboard", "summary"], queryFn: vi.fn() };

    await warmRouteQuery(queryClient as never, options);

    expect(queryClient.getQueryData).toHaveBeenCalledWith(options.queryKey);
    expect(queryClient.prefetchQuery).toHaveBeenCalledWith(options);
    expect(queryClient.ensureQueryData).not.toHaveBeenCalled();
  });

  it("awaits ensureQueryData on the client when cached data can render immediately", async () => {
    vi.stubGlobal("window", {});
    const queryClient = createQueryClientMock();
    queryClient.getQueryData.mockReturnValue({ stats: true });
    const options = { queryKey: ["dashboard", "summary"], queryFn: vi.fn() };

    await warmRouteQuery(queryClient as never, options);

    expect(queryClient.ensureQueryData).toHaveBeenCalledWith(options);
    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
  });
});
