import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRuntimeApiApp: vi.fn(),
}));

vi.mock("./runtime/fetch-runtime-app", () => ({
  fetchRuntimeApiApp: mocks.fetchRuntimeApiApp,
}));

import { renderPublicRead } from "./public-read";

function runtimeEnv() {
  const queue = { send: vi.fn(async () => undefined) };
  // The "already requested" marker is a per-colo Cache API entry keyed by the Worker version.
  const marked = new Set<string>();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (url: string) => (marked.has(url) ? new Response("1") : undefined),
      put: async (url: string) => { marked.add(url); },
    }),
  });
  return {
    env: { JOBS_QUEUE: queue, IMAGES: {}, CF_VERSION_METADATA: { id: "test-v1" } } as unknown as Env,
    queue,
  };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    settled: () => Promise.all(pending),
  };
}

describe("renderPublicRead rendition hints", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("queues renditions for an original a rendered public read publishes, and still returns the full body (Paid)", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
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

  it("queues nothing from a public read on the Free profile, which leaves renditions to the cron backlog", async () => {
    const payload = { data: { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" } };
    mocks.fetchRuntimeApiApp.mockResolvedValueOnce(Response.json(payload));
    const { env, queue } = runtimeEnv();
    const { ctx, settled } = executionContext();

    const response = await renderPublicRead(new Request("https://api.example.com/api/v1/products/lamp"), env, ctx);

    expect(await response.json()).toEqual(payload);
    await settled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("scans nothing for errors or uncacheable reads", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
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
