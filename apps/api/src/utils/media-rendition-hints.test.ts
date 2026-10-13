import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";

const mocks = vi.hoisted(() => ({ renderMissingMediaVariants: vi.fn() }));
vi.mock("@scalius/core/modules/media", () => ({ renderMissingMediaVariants: mocks.renderMissingMediaVariants }));
vi.mock("@scalius/database/client", () => ({ getDb: () => ({ id: "db" }) }));

import {
  MEDIA_RENDITION_HINT_MAX_IDS_PER_READ,
  findStillOriginalMedia,
  renderRenditionsForRenderedOriginals,
} from "./media-rendition-hints";

const CDN = "https://cdn.example.com";

function body(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function fakeEnv(seen: string[] = []) {
  const store = new Map(seen.map((id) => [markerUrl(id), "1"]));
  const cache = {
    match: vi.fn(async (url: string) => (store.has(url) ? new Response("1") : undefined)),
    put: vi.fn(async (url: string, response: Response) => {
      store.set(url, response.headers.get("Cache-Control") ?? "");
    }),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  return {
    env: { CF_VERSION_METADATA: { id: "v1" }, BUCKET: {} as R2Bucket, IMAGES: {} as ImagesBinding },
    cache,
  };
}

function markerUrl(id: string): string {
  return `https://media-rendition-hint.internal/v1/${id}`;
}

describe("findStillOriginalMedia", () => {
  it("finds own-media still originals and ignores renditions, GIFs, foreign paths and look-alikes", () => {
    const text = JSON.stringify({
      a: `${CDN}/media/media_legacy01.jpg`,
      b: `${CDN}/media/media_done0001.jpg/1600.webp`,
      c: `${CDN}/media/media_animated.gif`,
      d: "https://images.unsplash.com/photo-123.jpg",
      e: `${CDN}/other/media_notmedia.png`,
      f: `${CDN}/media/media_query001.PNG?v=2`,
      g: "media/media_relative.webp",
      h: `<img src="${CDN}/media/media_richtext.jpeg">`,
      i: `${CDN}/media/media_legacy01.jpg`,
      j: `${CDN}/media/media_legacy02.jpgx`,
    });

    expect(findStillOriginalMedia(text)).toEqual([
      { id: "media_legacy01", mimeType: "image/jpeg" },
      { id: "media_query001", mimeType: "image/png" },
      { id: "media_relative", mimeType: "image/webp" },
      { id: "media_richtext", mimeType: "image/jpeg" },
    ]);
  });

  it("stops at the per-read bound", () => {
    const urls = Array.from({ length: 40 }, (_, index) => `${CDN}/media/media_bulk${String(index).padStart(4, "0")}.png`);
    expect(findStillOriginalMedia(JSON.stringify(urls))).toHaveLength(MEDIA_RENDITION_HINT_MAX_IDS_PER_READ);
  });
});

// Rendering from a public read (with its Cache API dedupe marker) is the Paid
// profile's behaviour (background.renditionsPerPublicRead); the Free
// profile's is the describe after this one.
describe("renderRenditionsForRenderedOriginals", () => {
  beforeEach(() => {
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    mocks.renderMissingMediaVariants.mockReset().mockResolvedValue("generated");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders at once, once per original, marks it in the Cache API with a short TTL, and stops at the per-read limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, cache } = fakeEnv();
    const read = body({ imageUrl: `${CDN}/media/media_legacy01.jpg`, hover: `${CDN}/media/media_done0001.jpg/960.webp` });

    expect(await renderRenditionsForRenderedOriginals(read, env)).toEqual(["media_legacy01"]);
    expect(mocks.renderMissingMediaVariants).toHaveBeenCalledWith(expect.anything(), "media_legacy01", env.BUCKET, env.IMAGES);
    expect(cache.put).toHaveBeenCalledWith(markerUrl("media_legacy01"), expect.any(Response));
    const marker = cache.put.mock.calls[0]![1] as Response;
    expect(marker.headers.get("Cache-Control")).toBe("max-age=900");
    // One masked line per read; never the full id.
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls[0])).not.toContain("media_legacy01");

    // A listing's worth of originals renders the plan's share; the next read continues.
    const limit = PLAN_LIMITS.paid.background.renditionsPerPublicRead;
    const many = Array.from({ length: 30 }, (_, index) => `${CDN}/media/media_card${String(index).padStart(4, "0")}.jpg`);
    const first = await renderRenditionsForRenderedOriginals(body(many), env);
    expect(first).toHaveLength(limit);
    const second = await renderRenditionsForRenderedOriginals(body(many), env);
    expect(second).toHaveLength(limit);
    expect(second.some((id) => first.includes(id))).toBe(false);
    mocks.renderMissingMediaVariants.mockClear();

    // A second read inside the TTL is deduplicated by the marker.
    await renderRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_legacy01.jpg` }), env);
    expect(mocks.renderMissingMediaVariants).not.toHaveBeenCalled();
  });

  it("does nothing for reads without originals, or without the Worker version or Images binding, and never throws", async () => {
    const { env, cache } = fakeEnv();
    expect(await renderRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_done0001.jpg/960.webp` }), env)).toEqual([]);
    for (const missing of ["IMAGES", "CF_VERSION_METADATA"] as const) {
      const partial = { ...env, [missing]: undefined };
      expect(await renderRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), partial)).toEqual([]);
    }
    expect(mocks.renderMissingMediaVariants).not.toHaveBeenCalled();

    cache.match.mockRejectedValueOnce(new Error("cache down"));
    await expect(renderRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), env)).resolves.toBeDefined();
  });
});

describe("renderRenditionsForRenderedOriginals on the Free profile", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("renders nothing and touches no marker: the scheduled backfill renders", async () => {
    const { env, cache } = fakeEnv();
    const read = body({ imageUrl: `${CDN}/media/media_legacy01.jpg` });

    expect(await renderRenditionsForRenderedOriginals(read, env)).toEqual([]);
    expect(mocks.renderMissingMediaVariants).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
