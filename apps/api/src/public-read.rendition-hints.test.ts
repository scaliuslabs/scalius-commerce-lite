import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRuntimeApiApp: vi.fn(),
}));

vi.mock("./runtime/fetch-runtime-app", () => ({
  fetchRuntimeApiApp: mocks.fetchRuntimeApiApp,
}));

import { renderPublicRead } from "./public-read";

function runtimeEnv() {
  const queue = { send: vi.fn(async () => undefined) };
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  return { env: { JOBS_QUEUE: queue, CACHE: kv, IMAGES: {} } as unknown as Env, queue };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    settled: () => Promise.all(pending),
  };
}

describe("renderPublicRead rendition hints", () => {
  it("queues renditions for an original a rendered public read publishes, and still returns the full body", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = { data: { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" } };
    mocks.fetchRuntimeApiApp.mockResolvedValueOnce(Response.json(payload));
    const { env, queue } = runtimeEnv();
    const { ctx, settled } = executionContext();

    const response = await renderPublicRead(new Request("https://api.example.com/api/v1/products/lamp"), env, ctx);

    expect(await response.json()).toEqual(payload);
    await settled();
    expect(queue.send).toHaveBeenCalledWith(
      { type: "media.render_variants", mediaId: "media_legacy01" },
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    );
  });

  it("scans nothing for errors or uncacheable reads", async () => {
    const { env, queue } = runtimeEnv();
    const { ctx, settled } = executionContext();
    const original = { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" };
    mocks.fetchRuntimeApiApp
      .mockResolvedValueOnce(Response.json(original, { status: 404 }))
      .mockResolvedValueOnce(Response.json(original, { headers: { "Cache-Control": "private, no-store" } }));

    await renderPublicRead(new Request("https://api.example.com/api/v1/products/missing"), env, ctx);
    await renderPublicRead(new Request("https://api.example.com/api/v1/products/private"), env, ctx);
    await settled();

    expect(queue.send).not.toHaveBeenCalled();
  });
});
