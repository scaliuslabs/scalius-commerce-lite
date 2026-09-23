// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizeImagesButton } from "./OptimizeImagesButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchFilesMissingVariants: vi.fn(),
  fetchOriginal: vi.fn(),
  saveVariants: vi.fn(),
}));
const encoder = vi.hoisted(() => ({ encodeMediaVariants: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../api", () => ({ MediaApiClient: api }));
vi.mock("../utils/media-variants", () => encoder);
vi.mock("sonner", () => ({ toast }));

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

const page = (ids: string[], hasMore = false) => ({
  files: ids.map((id) => ({ id })),
  pagination: { limit: 20, hasMore, nextCursor: hasMore ? "next" : null },
});

describe("OptimizeImagesButton", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.values(api).forEach((mock) => mock.mockReset());
    encoder.encodeMediaVariants.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("stays hidden when every image already has renditions", async () => {
    api.fetchFilesMissingVariants.mockResolvedValue(page([]));
    act(() => root.render(<OptimizeImagesButton onOptimized={vi.fn()} />));
    await flush();
    expect(host.textContent).toBe("");
  });

  it("renders renditions for every pending image through the browser pipeline", async () => {
    const onOptimized = vi.fn();
    const variants = { width: 800, height: 800, files: new Map() };
    api.fetchFilesMissingVariants
      .mockResolvedValueOnce(page(["media_a", "media_b"]))
      .mockResolvedValueOnce(page(["media_a"], true))
      .mockResolvedValueOnce(page(["media_b"]))
      .mockResolvedValueOnce(page([]));
    api.fetchOriginal.mockResolvedValue(new Blob(["x"]));
    encoder.encodeMediaVariants.mockResolvedValueOnce(variants).mockResolvedValueOnce(null);
    api.saveVariants.mockResolvedValue({});

    act(() => root.render(<OptimizeImagesButton onOptimized={onOptimized} />));
    await flush();
    expect(host.textContent).toContain("Optimize 2 images");

    await act(async () => { host.querySelector("button")!.click(); });
    await flush();

    expect(api.fetchOriginal).toHaveBeenCalledTimes(2);
    expect(api.saveVariants).toHaveBeenCalledOnce();
    expect(api.saveVariants).toHaveBeenCalledWith("media_a", variants);
    expect(toast.error).toHaveBeenCalledWith("1 optimized, 1 not optimized", expect.any(Object));
    expect(onOptimized).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  });
});
