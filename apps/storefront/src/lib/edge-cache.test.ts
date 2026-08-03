import { describe, expect, it, vi } from "vitest";

import { withEdgeCache } from "./edge-cache";

describe("withEdgeCache", () => {
  it("deduplicates only concurrent identical reads", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = withEdgeCache("layout", fetcher);
    const duplicate = withEdgeCache("layout", fetcher);
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
