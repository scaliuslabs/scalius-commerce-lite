import { describe, expect, it } from "vitest";
import { readStillWebp } from "./webp-info";

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const le24 = (value: number) => le32(value).slice(0, 3);

function riff(chunks: number[]): Uint8Array {
  return new Uint8Array([...ascii("RIFF"), ...le32(chunks.length + 4), ...ascii("WEBP"), ...chunks]);
}

/** A lossy chunk header with real size fields and padding for the payload. */
function lossy(width: number, height: number): Uint8Array {
  const payload = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0];
  return riff([...ascii("VP8 "), ...le32(payload.length), ...payload]);
}

function lossless(width: number, height: number): Uint8Array {
  const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const payload = [0x2f, ...le32(packed), 0, 0, 0, 0, 0, 0, 0, 0];
  return riff([...ascii("VP8L"), ...le32(payload.length), ...payload]);
}

function extended(width: number, height: number, flags = 0): Uint8Array {
  const payload = [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  return riff([...ascii("VP8X"), ...le32(payload.length), ...payload]);
}

describe("readStillWebp", () => {
  it("reads the size of lossy, lossless and extended stills", () => {
    expect(readStillWebp(lossy(1200, 900))).toEqual({ width: 1200, height: 900 });
    expect(readStillWebp(lossless(2560, 1440))).toEqual({ width: 2560, height: 1440 });
    expect(readStillWebp(extended(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("refuses animation, other containers and truncated or padded files", () => {
    expect(readStillWebp(extended(640, 480, 0x02))).toBeNull();
    expect(readStillWebp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))).toBeNull();
    const good = lossy(10, 10);
    expect(readStillWebp(good.slice(0, good.length - 1))).toBeNull();
    expect(readStillWebp(new Uint8Array([...good, 0x3c, 0x73, 0x63]))).toBeNull();
  });

  it("refuses a first chunk that is not an image chunk", () => {
    const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(readStillWebp(riff([...ascii("EXIF"), ...le32(payload.length), ...payload]))).toBeNull();
  });
});
