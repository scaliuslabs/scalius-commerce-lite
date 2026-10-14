import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_IMAGE_MAX_EDGE_PX, encodeImageAsWebp } from "./browser-image";

const drawn: Array<[number, number]> = [];

function stubBrowser(options: { webp?: boolean; bitmap?: { width: number; height: number } | null } = {}) {
  const bitmap = options.bitmap === undefined ? { width: 4000, height: 3000 } : options.bitmap;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    if (!bitmap) throw new Error("undecodable");
    return { ...bitmap, close: vi.fn() };
  }));
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() {
      return { drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => drawn.push([width, height]) };
    }
    async convertToBlob({ type }: { type: string }) {
      return new Blob(["encoded"], { type: options.webp === false ? "image/png" : type });
    }
  });
}

afterEach(() => {
  drawn.length = 0;
  vi.unstubAllGlobals();
});

describe("encodeImageAsWebp", () => {
  it("scales a large photo to the edge cap and returns a .webp file", async () => {
    stubBrowser();
    const result = await encodeImageAsWebp(new File(["x"], "IMG_0042.JPG", { type: "image/jpeg" }));
    expect(drawn).toEqual([[BROWSER_IMAGE_MAX_EDGE_PX, 1920]]);
    expect(result).toMatchObject({ name: "IMG_0042.webp", type: "image/webp" });
  });

  it("keeps a small photo at its own size", async () => {
    stubBrowser({ bitmap: { width: 800, height: 600 } });
    await encodeImageAsWebp(new File(["x"], "small.png", { type: "image/png" }));
    expect(drawn).toEqual([[800, 600]]);
  });

  it("returns null when the browser cannot decode the file or cannot encode WebP", async () => {
    stubBrowser({ bitmap: null });
    expect(await encodeImageAsWebp(new File(["x"], "broken.jpg", { type: "image/jpeg" }))).toBeNull();
    stubBrowser({ webp: false });
    expect(await encodeImageAsWebp(new File(["x"], "photo.jpg", { type: "image/jpeg" }))).toBeNull();
    vi.stubGlobal("createImageBitmap", undefined);
    expect(await encodeImageAsWebp(new File(["x"], "photo.jpg", { type: "image/jpeg" }))).toBeNull();
  });
});
