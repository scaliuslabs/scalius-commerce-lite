import { describe, expect, it } from "vitest";

import { inspectGeneratedRaster } from "./generated-raster";

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
const JPEG_1X1 = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
]);

describe("generated raster inspection", () => {
  it("accepts a structurally complete bounded raster and reports dimensions", () => {
    expect(inspectGeneratedRaster(PNG_1X1, "image/png")).toEqual({
      mediaType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("rejects arbitrary bytes and MIME spoofing", () => {
    expect(
      inspectGeneratedRaster(new Uint8Array([1, 2, 3]), "image/png"),
    ).toBeNull();
    expect(inspectGeneratedRaster(PNG_1X1, "image/jpeg")).toBeNull();
  });

  it("rejects a header-only PNG that cannot contain image data", () => {
    expect(inspectGeneratedRaster(PNG_1X1.subarray(0, 24), "image/png"))
      .toBeNull();
  });

  it("rejects trailing payloads after the terminal PNG chunk", () => {
    const polyglot = new Uint8Array(PNG_1X1.byteLength + 4);
    polyglot.set(PNG_1X1);
    polyglot.set([60, 115, 118, 103], PNG_1X1.byteLength);
    expect(inspectGeneratedRaster(polyglot, "image/png")).toBeNull();
  });

  it("requires JPEG EOI to be terminal", () => {
    expect(inspectGeneratedRaster(JPEG_1X1, "image/jpeg")).toMatchObject({
      width: 1,
      height: 1,
    });
    const trailing = new Uint8Array(JPEG_1X1.byteLength + 1);
    trailing.set(JPEG_1X1);
    trailing[trailing.length - 1] = 0x00;
    expect(inspectGeneratedRaster(trailing, "image/jpeg")).toBeNull();
  });

  it("rejects dimensions above the decoded-pixel safety bound", () => {
    const oversized = PNG_1X1.slice();
    oversized.set([0, 0, 128, 0], 16);
    oversized.set([0, 0, 128, 0], 20);
    expect(inspectGeneratedRaster(oversized, "image/png")).toBeNull();
  });
});
