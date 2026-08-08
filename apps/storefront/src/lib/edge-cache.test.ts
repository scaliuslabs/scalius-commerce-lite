import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  store: undefined as { inflightReads: Map<string, Promise<unknown>> } | undefined,
}));

vi.mock("./api/context", () => ({
  apiContext: { getStore: () => context.store },
}));

import { withEdgeCache } from "./edge-cache";

function runRequest<T>(callback: () => T): T {
  const previous = context.store;
  context.store = { inflightReads: new Map() };
  try {
    return callback();
  } finally {
    context.store = previous;
  }
}

describe("withEdgeCache", () => {
  it("deduplicates only concurrent identical reads", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const [first, duplicate] = runRequest(() => [
      withEdgeCache("layout", fetcher),
      withEdgeCache("layout", fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch?.("fresh");
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "fresh",
      "fresh",
    ]);

    fetcher.mockResolvedValueOnce("new-read");
    await expect(withEdgeCache("layout", fetcher)).resolves.toBe("new-read");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never shares an in-flight backend promise across requests", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce("second-request");

    const first = runRequest(() => withEdgeCache("layout", fetcher));
    const second = runRequest(() => withEdgeCache("layout", fetcher));

    await expect(second).resolves.toBe("second-request");
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolveFirst?.("first-request");
    await expect(first).resolves.toBe("first-request");
  });

  it("does not retain failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("recovered");

    await expect(withEdgeCache("settings", fetcher)).resolves.toBeNull();
    await expect(withEdgeCache("settings", fetcher)).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
