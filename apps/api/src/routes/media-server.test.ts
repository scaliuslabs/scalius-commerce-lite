import { describe, expect, it, vi } from "vitest";
import { serveMediaRoute } from "./media-server";

function object(
  key: string,
  body: string,
  options: { size?: number; offset?: number; length?: number } = {},
) {
  return {
    key,
    version: "v1",
    size: options.size ?? body.length,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(0),
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: {},
    body: new Response(body).body!,
    bodyUsed: false,
    arrayBuffer: vi.fn(),
    text: vi.fn(),
    json: vi.fn(),
    blob: vi.fn(),
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "video/mp4");
    },
    ...(options.offset === undefined
      ? {}
      : { range: { offset: options.offset, length: options.length } }),
  } as unknown as R2ObjectBody;
}

function env(get: ReturnType<typeof vi.fn>) {
  return { BUCKET: { get } } as unknown as Env;
}

describe("local media passthrough", () => {
  it("serves nested immutable media keys instead of matching one segment", async () => {
    const get = vi.fn().mockResolvedValue(
      object("media/media_abcdefghijklmnop.mp4", "video"),
    );

    const response = await serveMediaRoute.request(
      "/media/media_abcdefghijklmnop.mp4",
      undefined,
      env(get),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(get).toHaveBeenCalledWith(
      "media/media_abcdefghijklmnop.mp4",
      undefined,
    );
  });

  it("forwards byte ranges and returns a seekable partial response", async () => {
    const get = vi.fn().mockResolvedValue(
      object("media/media_abcdefghijklmnop.mp4", "clip", {
        size: 20,
        offset: 5,
        length: 4,
      }),
    );

    const response = await serveMediaRoute.request(
      "/media/media_abcdefghijklmnop.mp4",
      { headers: { Range: "bytes=5-8" } },
      env(get),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 5-8/20");
    expect(response.headers.get("content-length")).toBe("4");
    expect(get).toHaveBeenCalledWith(
      "media/media_abcdefghijklmnop.mp4",
      expect.objectContaining({ range: expect.any(Headers) }),
    );
  });

  it("rejects unsupported object keys before reading R2", async () => {
    const get = vi.fn();
    const response = await serveMediaRoute.request(
      "/media/media_abcdefghijklmnop.exe",
      undefined,
      env(get),
    );

    expect(response.status).toBe(500);
    expect(get).not.toHaveBeenCalled();
  });
});
