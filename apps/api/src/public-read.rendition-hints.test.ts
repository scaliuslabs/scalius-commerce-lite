import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRuntimeApiApp: vi.fn(),
  render: vi.fn(async (_response: Response, _env: unknown) => [] as string[]),
}));

vi.mock("./runtime/fetch-runtime-app", () => ({
  fetchRuntimeApiApp: mocks.fetchRuntimeApiApp,
}));
vi.mock("./utils/media-rendition-hints", () => ({
  renderRenditionsForRenderedOriginals: mocks.render,
}));

import { renderPublicRead } from "./public-read";

const env = { IMAGES: {}, CF_VERSION_METADATA: { id: "test-v1" } } as unknown as Env;

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    settled: () => Promise.all(pending),
  };
}

describe("renderPublicRead rendition hints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.render.mockClear();
  });

  it("renders renditions for a rendered public read after the response, and still returns the full body (Paid)", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    const payload = { data: { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" } };
    mocks.fetchRuntimeApiApp.mockResolvedValueOnce(Response.json(payload));
    const { ctx, settled } = executionContext();

    const response = await renderPublicRead(new Request("https://api.example.com/api/v1/products/lamp"), env, ctx);

    expect(await response.json()).toEqual(payload);
    await settled();
    expect(mocks.render).toHaveBeenCalledTimes(1);
    const [clone] = mocks.render.mock.calls[0]!;
    expect(await clone.json()).toEqual(payload);
  });

  it("renders nothing from a public read on the Free profile, which leaves renditions to the scheduled backfill", async () => {
    const payload = { data: { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" } };
    mocks.fetchRuntimeApiApp.mockResolvedValueOnce(Response.json(payload));
    const { ctx, settled } = executionContext();

    const response = await renderPublicRead(new Request("https://api.example.com/api/v1/products/lamp"), env, ctx);

    expect(await response.json()).toEqual(payload);
    await settled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("scans nothing for errors or uncacheable reads", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    const { ctx, settled } = executionContext();
    const original = { imageUrl: "https://cdn.example.com/media/media_legacy01.jpg" };
    mocks.fetchRuntimeApiApp
      .mockResolvedValueOnce(Response.json(original, { status: 404 }))
      .mockResolvedValueOnce(Response.json(original, { headers: { "Cache-Control": "private, no-store" } }));

    await renderPublicRead(new Request("https://api.example.com/api/v1/products/missing"), env, ctx);
    await renderPublicRead(new Request("https://api.example.com/api/v1/products/private"), env, ctx);
    await settled();

    expect(mocks.render).not.toHaveBeenCalled();
  });
});
