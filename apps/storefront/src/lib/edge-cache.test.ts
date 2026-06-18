import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/build-id", () => ({ BUILD_ID: "test-build" }));

import { withEdgeCache } from "./edge-cache";

describe("withEdgeCache", () => {
  it("dedupes concurrent fetches even when KV versioning is unavailable", async () => {
    let resolveFirstFetch: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirstFetch = resolve;
        }),
    );

    const first = withEdgeCache("layout_data", fetcher);
    const duplicate = withEdgeCache("layout_data", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFirstFetch?.("fresh-layout");

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "fresh-layout",
      "fresh-layout",
    ]);

    fetcher.mockResolvedValueOnce("next-layout");
    await expect(withEdgeCache("layout_data", fetcher)).resolves.toBe(
      "next-layout",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
