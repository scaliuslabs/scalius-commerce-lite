import { describe, expect, it } from "vitest";

import {
  MEDIA_MAX_FILES_PER_UPLOAD,
  MEDIA_POLICY,
  detectMediaMimeType,
  validateMediaFileMetadata,
  validateMediaSignature,
} from "./media-policy";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function ftyp(...brands: string[]): Uint8Array {
  const size = 16 + Math.max(0, brands.length - 1) * 4;
  return bytes(
    0,
    0,
    0,
    size,
    ...ascii("ftyp"),
    ...ascii(brands[0] ?? "isom"),
    0,
    0,
    0,
    0,
    ...brands.slice(1).flatMap(ascii),
  );
}

describe("media upload policy", () => {
  it("keeps one explicit batch and kind-specific size authority", () => {
    expect(MEDIA_MAX_FILES_PER_UPLOAD).toBe(50);
    expect(MEDIA_POLICY["image/png"].maxBytes).toBe(20 * 1024 * 1024);
    expect(MEDIA_POLICY["video/mp4"].maxBytes).toBe(100 * 1024 * 1024);
  });

  it("accepts supported metadata and rejects mismatched extensions and kinds", () => {
    expect(
      validateMediaFileMetadata({
        filename: "Cafeteria walkthrough.mp4",
        mimeType: "video/mp4",
        size: 24 * 1024 * 1024,
      }),
    ).toMatchObject({ ok: true, value: { kind: "video", extension: "mp4" } });
    expect(
      validateMediaFileMetadata({
        filename: "photo.png",
        mimeType: "image/jpeg",
        size: 100,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateMediaFileMetadata({
        filename: "clip.mp4",
        mimeType: "video/mp4",
        size: 100,
        expectedKind: "image",
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects empty, oversized, unsafe, and intentionally unsupported files", () => {
    for (const input of [
      { filename: "empty.png", mimeType: "image/png", size: 0 },
      {
        filename: "huge.webm",
        mimeType: "video/webm",
        size: 100 * 1024 * 1024 + 1,
      },
      { filename: "../photo.png", mimeType: "image/png", size: 100 },
      { filename: "active.svg", mimeType: "image/svg+xml", size: 100 },
      { filename: "scan.tiff", mimeType: "image/tiff", size: 100 },
      { filename: "legacy.bmp", mimeType: "image/bmp", size: 100 },
    ]) {
      expect(validateMediaFileMetadata(input)).toMatchObject({ ok: false });
    }
  });
});

describe("media signature validation", () => {
  it.each([
    ["image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["image/gif", bytes(...ascii("GIF89a"))],
    ["image/webp", bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP"))],
    ["image/avif", ftyp("avif", "mif1")],
    ["video/mp4", ftyp("isom", "avc1")],
    [
      "video/webm",
      bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...ascii("webm")),
    ],
  ] as const)("detects %s from bounded header bytes", (mimeType, signature) => {
    expect(detectMediaMimeType(signature)).toBe(mimeType);
    expect(validateMediaSignature(signature, mimeType)).toEqual({
      ok: true,
      value: mimeType,
    });
  });

  it("does not confuse AVIF with MP4 and rejects spoofed labels", () => {
    const avif = ftyp("avif", "mif1");
    expect(validateMediaSignature(avif, "video/mp4")).toMatchObject({ ok: false });
    expect(
      validateMediaSignature(bytes(...ascii("not really a png")), "image/png"),
    ).toMatchObject({ ok: false });
  });

  it("does not accept generic Matroska, QuickTime, or weak RIFF headers", () => {
    expect(
      detectMediaMimeType(
        bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...ascii("matroska")),
      ),
    ).toBeNull();
    expect(detectMediaMimeType(ftyp("qt  "))).toBeNull();
    expect(detectMediaMimeType(bytes(...ascii("RIFF"), 1, 2, 3, 4))).toBeNull();
  });
});
