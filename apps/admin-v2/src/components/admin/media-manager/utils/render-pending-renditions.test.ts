import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPendingRenditions } from "./render-pending-renditions";

const api = vi.hoisted(() => ({
  fetchFilesMissingVariants: vi.fn(),
  fetchOriginal: vi.fn(),
  saveVariants: vi.fn(),
}));
const encoder = vi.hoisted(() => ({ encodeMediaVariants: vi.fn() }));

vi.mock("../api", () => ({ MediaApiClient: api }));
vi.mock("./media-variants", () => encoder);

const NOW = Date.parse("2026-10-15T12:00:00Z");
const file = (id: string, ageMs = 60 * 60_000) => ({ id, createdAt: new Date(NOW - ageMs) });
const page = (files: Array<ReturnType<typeof file>>, nextCursor: string | null = null) => ({
  files,
  pagination: { limit: 20, hasMore: nextCursor !== null, nextCursor },
});
const variants = { width: 800, height: 600, files: new Map() };

describe("renderPendingRenditions", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    encoder.encodeMediaVariants.mockReset().mockResolvedValue(variants);
    api.fetchOriginal.mockResolvedValue(new Blob(["x"]));
    api.saveVariants.mockResolvedValue({});
  });

  it("renders every pending image page by page and reports each outcome", async () => {
    api.fetchFilesMissingVariants
      .mockResolvedValueOnce(page([file("media_a"), file("media_b")], "c2"))
      .mockResolvedValueOnce(page([file("media_c")]));
    encoder.encodeMediaVariants.mockResolvedValueOnce(variants).mockResolvedValueOnce(null).mockResolvedValueOnce(variants);
    const outcomes: string[] = [];
    const skip = new Set<string>();

    const result = await renderPendingRenditions({ limit: 100, skip, now: () => NOW, onImage: (outcome) => outcomes.push(outcome) });

    expect(result).toEqual({ rendered: 2, failed: 1, more: false });
    expect(outcomes).toEqual(["rendered", "failed", "rendered"]);
    expect(api.saveVariants.mock.calls.map((call) => call[0])).toEqual(["media_a", "media_c"]);
    expect([...skip]).toEqual(["media_b"]);
    expect(api.fetchFilesMissingVariants).toHaveBeenNthCalledWith(2, "c2", 20);
  });

  it("stops at its limit and says more remain", async () => {
    api.fetchFilesMissingVariants.mockResolvedValue(page([file("media_a"), file("media_b"), file("media_c")]));

    const result = await renderPendingRenditions({ limit: 2, skip: new Set(), now: () => NOW });

    expect(result).toEqual({ rendered: 2, failed: 0, more: true });
    expect(api.saveVariants).toHaveBeenCalledTimes(2);
  });

  it("leaves a fresh upload to its own pipeline and never retries a failed id", async () => {
    api.fetchFilesMissingVariants.mockResolvedValue(page([file("media_new", 30_000), file("media_failed"), file("media_old")]));

    const result = await renderPendingRenditions({
      limit: 10, minAgeMs: 120_000, skip: new Set(["media_failed"]), now: () => NOW,
    });

    expect(result).toEqual({ rendered: 1, failed: 0, more: true });
    expect(api.fetchOriginal).toHaveBeenCalledTimes(1);
    expect(api.fetchOriginal).toHaveBeenCalledWith("media_old");
  });

  it("checks shouldStop before each image and pauses after each", async () => {
    api.fetchFilesMissingVariants.mockResolvedValue(page([file("media_a"), file("media_b")]));
    let stop = false;
    const pause = vi.fn(async () => { stop = true; });

    const result = await renderPendingRenditions({
      limit: 10, skip: new Set(), now: () => NOW, shouldStop: () => stop, pause,
    });

    expect(result).toEqual({ rendered: 1, failed: 0, more: true });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(api.saveVariants).toHaveBeenCalledTimes(1);
  });

  it("counts a failed save as a failure without throwing", async () => {
    api.fetchFilesMissingVariants.mockResolvedValue(page([file("media_a")]));
    api.saveVariants.mockRejectedValue(new Error("offline"));
    const skip = new Set<string>();

    await expect(renderPendingRenditions({ limit: 10, skip, now: () => NOW })).resolves.toEqual({ rendered: 0, failed: 1, more: false });
    expect(skip.has("media_a")).toBe(true);
  });
});
