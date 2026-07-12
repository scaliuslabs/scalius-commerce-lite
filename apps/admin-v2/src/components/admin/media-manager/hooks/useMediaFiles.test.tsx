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
