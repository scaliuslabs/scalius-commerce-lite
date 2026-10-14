// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { MEDIA_CACHE_MAX_BYTES, mediaCacheKey, mediaKeyOfPath, serveStorefrontMedia } from "./media-proxy";

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    cache: {
      match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
      put: vi.fn(async (request: Request | string, response: Response) => {
        store.set(typeof request === "string" ? request : request.url, response);
      }),
    } as unknown as Cache,
  };
}

function upstreamImage(bytes = "webp-bytes", headers: Record<string, string> = {}) {
  return new Response(bytes, {
    headers: { "Content-Type": "image/webp", "Content-Length": String(bytes.length), ETag: '"e1"', ...headers },
  });
}

function context(fetch: ReturnType<typeof vi.fn>, cache: Cache | null, waits: Promise<unknown>[] = []) {
  return {
    env: { BACKEND_API: { fetch } as unknown as Fetcher },
    workerVersion: "v1",
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    cache,
  };
}

const get = (path: string, init?: RequestInit) => new Request(`https://shop.example.test${path}`, init);

describe("mediaKeyOfPath", () => {
  it("names the object key of a media path and nothing else", () => {
    expect(mediaKeyOfPath("/media/media_abc.jpg")).toBe("media/media_abc.jpg");
    expect(mediaKeyOfPath("/media/media_abc.jpg/960.webp")).toBe("media/media_abc.jpg/960.webp");
    for (const path of [
      "/media", "/media/", "/medias/a.jpg", "/media/../private/a.png", "/media//a.jpg", "/media/a.jpg/", "/media/a",
      "/media/a%2F..%2Fb.jpg", "/media/a.jpg/0.webp", "/private/a.jpg", `/media/${"a".repeat(300)}.jpg`,
    ]) expect(mediaKeyOfPath(path), path).toBeNull();
  });
});

describe("serveStorefrontMedia", () => {
  it("ignores every other path, so a CMS page called media still renders", async () => {
    const fetch = vi.fn();
    expect(await serveStorefrontMedia(get("/media"), context(fetch, null))).toBeNull();
    expect(await serveStorefrontMedia(get("/products/x"), context(fetch, null))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed key and 405 for a write, without reading the API", async () => {
    const fetch = vi.fn();
    expect((await serveStorefrontMedia(get("/media/a"), context(fetch, null)))!.status).toBe(404);
    expect((await serveStorefrontMedia(get("/media/a.jpg", { method: "POST" }), context(fetch, null)))!.status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams a miss from the API as immutable and stores a copy; a hit reads the cache only", async () => {
    const { cache, store } = fakeCache();
    const waits: Promise<unknown>[] = [];
    const fetch = vi.fn(async (_request: Request) => upstreamImage());

    const miss = (await serveStorefrontMedia(get("/media/media_abc.jpg/960.webp"), context(fetch, cache, waits)))!;
    expect(miss.status).toBe(200);
    expect(await miss.text()).toBe("webp-bytes");
    expect(miss.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(miss.headers.get("Content-Type")).toBe("image/webp");
    expect(miss.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].url).toBe("https://api.internal/api/v1/media/media/media_abc.jpg/960.webp");
    await Promise.all(waits);
    expect([...store.keys()]).toEqual([mediaCacheKey("https://shop.example.test", "v1", "media/media_abc.jpg/960.webp")]);

    const hit = (await serveStorefrontMedia(get("/media/media_abc.jpg/960.webp"), context(fetch, cache)))!;
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe("webp-bytes");
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps one store's and one release's entries apart", () => {
    const key = "media/a.jpg";
    expect(mediaCacheKey("https://a.test", "v1", key)).not.toBe(mediaCacheKey("https://b.test", "v1", key));
    expect(mediaCacheKey("https://a.test", "v1", key)).not.toBe(mediaCacheKey("https://a.test", "v2", key));
  });

  it("does not store without a Worker version or past the size cap, and does not store a HEAD", async () => {
    const { cache, store } = fakeCache();
    const waits: Promise<unknown>[] = [];
    const fetch = vi.fn(async () => upstreamImage());
    await serveStorefrontMedia(get("/media/a.jpg"), { ...context(fetch, cache, waits), workerVersion: null });
    const big = vi.fn(async () => upstreamImage("x", { "Content-Length": String(MEDIA_CACHE_MAX_BYTES + 1) }));
    await serveStorefrontMedia(get("/media/b.mp4"), context(big, cache, waits));
    const head = (await serveStorefrontMedia(get("/media/c.jpg", { method: "HEAD" }), context(fetch, cache, waits)))!;
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    await Promise.all(waits);
    expect(store.size).toBe(0);
  });

  it("passes a range request through uncached and keeps its partial answer", async () => {
    const { cache, store } = fakeCache();
    const waits: Promise<unknown>[] = [];
    const fetch = vi.fn(async (_request: Request) => new Response("clip", {
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Length": "4", "Content-Range": "bytes 5-8/20" },
    }));
    const response = (await serveStorefrontMedia(get("/media/v.mp4", { headers: { Range: "bytes=5-8" } }), context(fetch, cache, waits)))!;
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 5-8/20");
    expect(fetch.mock.calls[0]![0].headers.get("Range")).toBe("bytes=5-8");
    await Promise.all(waits);
    expect(store.size).toBe(0);
  });

  it("answers 404 for a missing object and 502 for an API failure, neither cached", async () => {
    const { cache, store } = fakeCache();
    const waits: Promise<unknown>[] = [];
    const missing = (await serveStorefrontMedia(get("/media/a.jpg"), context(vi.fn(async () => new Response("no", { status: 404 })), cache, waits)))!;
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    const broken = (await serveStorefrontMedia(get("/media/a.jpg"), context(vi.fn(async () => new Response("x", { status: 500 })), cache, waits)))!;
    expect(broken.status).toBe(502);
    const thrown = (await serveStorefrontMedia(get("/media/a.jpg"), context(vi.fn(async () => { throw new Error("down"); }), cache, waits)))!;
    expect(thrown.status).toBe(502);
    await Promise.all(waits);
    expect(store.size).toBe(0);
  });
});
