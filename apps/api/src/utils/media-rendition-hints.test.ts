import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_VARIANTS_JOB_DELAY_SECONDS } from "@scalius/core/modules/media";

import {
  MEDIA_RENDITION_HINT_KV_PREFIX,
  MEDIA_RENDITION_HINT_MAX_IDS_PER_READ,
  MEDIA_RENDITION_HINT_TTL_SECONDS,
  findStillOriginalMedia,
  queueRenditionsForRenderedOriginals,
} from "./media-rendition-hints";

const CDN = "https://cdn.example.com";

function body(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function fakeEnv(seen: string[] = []) {
  const store = new Map(seen.map((id) => [`${MEDIA_RENDITION_HINT_KV_PREFIX}${id}`, "1"]));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  const queue = { send: vi.fn(async () => undefined) };
  return { env: { CACHE: kv, JOBS_QUEUE: queue, IMAGES: {} as ImagesBinding }, kv, queue };
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
    const urls = Array.from({ length: 20 }, (_, index) => `${CDN}/media/media_bulk${String(index).padStart(4, "0")}.png`);
    expect(findStillOriginalMedia(JSON.stringify(urls))).toHaveLength(MEDIA_RENDITION_HINT_MAX_IDS_PER_READ);
  });
});

describe("queueRenditionsForRenderedOriginals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues the delayed render job once per original and marks it in KV with a short TTL", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, kv, queue } = fakeEnv();
    const read = body({ imageUrl: `${CDN}/media/media_legacy01.jpg`, hover: `${CDN}/media/media_done0001.jpg/960.webp` });

    expect(await queueRenditionsForRenderedOriginals(read, env)).toEqual(["media_legacy01"]);
    expect(queue.send).toHaveBeenCalledWith(
      { type: "media.render_variants", mediaId: "media_legacy01" },
      { delaySeconds: MEDIA_VARIANTS_JOB_DELAY_SECONDS },
    );
    expect(kv.put).toHaveBeenCalledWith(`${MEDIA_RENDITION_HINT_KV_PREFIX}media_legacy01`, "1", {
      expirationTtl: MEDIA_RENDITION_HINT_TTL_SECONDS,
    });
    // One masked line per enqueue; never the full id.
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls[0])).not.toContain("media_legacy01");

    // A second read inside the TTL is deduplicated by the KV marker.
    await queueRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_legacy01.jpg` }), env);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("does nothing for reads without originals, or without the queue, KV or Images binding", async () => {
    const { env, queue } = fakeEnv();
    expect(await queueRenditionsForRenderedOriginals(body({ imageUrl: `${CDN}/media/media_done0001.jpg/960.webp` }), env)).toEqual([]);
    for (const missing of ["IMAGES", "JOBS_QUEUE", "CACHE"] as const) {
      const partial = { ...env, [missing]: undefined };
      expect(await queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), partial)).toEqual([]);
    }
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("leaves no KV marker when the queue rejects, so the next read retries, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, kv, queue } = fakeEnv();
    queue.send.mockRejectedValueOnce(new Error("queue down"));

    expect(await queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), env)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();

    kv.get.mockRejectedValueOnce(new Error("kv down"));
    await expect(queueRenditionsForRenderedOriginals(body({ u: `${CDN}/media/media_legacy01.jpg` }), env)).resolves.toBeDefined();
  });
});
