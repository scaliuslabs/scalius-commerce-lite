import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEDIA_RENDITION_HINT_MAX_IDS_PER_READ,
  findStillOriginalMedia,
  queueRenditionsForRenderedOriginals,
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
  const queue = { send: vi.fn(async () => undefined) };
  return {
    env: { CF_VERSION_METADATA: { id: "v1" }, JOBS_QUEUE: queue, IMAGES: {} as ImagesBinding },
    cache,
    queue,
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

// Queueing a rendition from a public read (and its Cache API dedupe marker) is the
// Paid profile's behaviour (queue.renditionsFromPublicReads); the Free
// profile's is the describe after this one.
describe("queueRenditionsForRenderedOriginals", () => {
  beforeEach(() => { vi.stubGlobal("__SCALIUS_PLAN__", "paid"); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("queues the render job at once, once per original, and marks it in the Cache API with a short TTL", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, cache, queue } = fakeEnv();
    const read = body({ imageUrl: `${CDN}/media/media_legacy01.jpg`, hover: `${CDN}/media/media_done0001.jpg/960.webp` });

    expect(await queueRenditionsForRenderedOriginals(read, env)).toEqual(["media_legacy01"]);
    expect(queue.send).toHaveBeenCalledWith(
      { type: "media.render_variants", mediaId: "media_legacy01" },
      { delaySeconds: 0 },
    );
    expect(cache.put).toHaveBeenCalledWith(markerUrl("media_legacy01"), expect.any(Response));
    const marker = cache.put.mock.calls[0]![1] as Response;
    expect(marker.headers.get("Cache-Control")).toBe("max-age=900");
    // One masked line per enqueue; never the full id.
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls[0])).not.toContain("media_legacy01");

    // A listing's worth of originals queues together, one masked line in all.
    vi.mocked(console.log).mockClear();
    const many = Array.from({ length: 30 }, (_, index) => `${CDN}/media/media_card${String(index).padStart(4, "0")}.jpg`);
    expect(await queueRenditionsForRenderedOriginals(body(many), env)).toHaveLength(MEDIA_RENDITION_HINT_MAX_IDS_PER_READ);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls[0])).not.toContain("media_card0000");
    queue.send.mockClear();

    // A second read inside the TTL is deduplicated by the marker.
    await queueRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_legacy01.jpg` }), env);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does nothing for reads without originals, or without the queue, Worker version or Images binding", async () => {
    const { env, queue } = fakeEnv();
    expect(await queueRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_done0001.jpg/960.webp` }), env)).toEqual([]);
    for (const missing of ["IMAGES", "JOBS_QUEUE", "CF_VERSION_METADATA"] as const) {
      const partial = { ...env, [missing]: undefined };
      expect(await queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), partial)).toEqual([]);
    }
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("leaves no marker when the queue rejects, so the next read retries, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, cache, queue } = fakeEnv();
    queue.send.mockRejectedValueOnce(new Error("queue down"));

    expect(await queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), env)).toEqual([]);
    expect(cache.put).not.toHaveBeenCalled();

    cache.match.mockRejectedValueOnce(new Error("cache down"));
    await expect(queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), env)).resolves.toBeDefined();
  });
});

describe("queueRenditionsForRenderedOriginals on the Free profile", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("queues nothing and touches neither the marker nor the queue: the scheduled backfill renders", async () => {
    const { env, cache, queue } = fakeEnv();
    const read = body({ imageUrl: `${CDN}/media/media_legacy01.jpg` });

    expect(await queueRenditionsForRenderedOriginals(read, env)).toEqual([]);
    expect(queue.send).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
