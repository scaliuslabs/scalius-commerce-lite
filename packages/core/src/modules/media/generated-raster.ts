const MAX_GENERATED_RASTER_DIMENSION = 32_768;
const MAX_GENERATED_RASTER_PIXELS = 100_000_000;

export const GENERATED_RASTER_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type GeneratedRasterMediaType =
  (typeof GENERATED_RASTER_MEDIA_TYPES)[number];

export interface GeneratedRasterInfo {
  mediaType: GeneratedRasterMediaType;
  width: number;
  height: number;
}

export function inspectGeneratedRaster(
  value: ArrayBuffer | Uint8Array,
  declaredMediaType: string,
): GeneratedRasterInfo | null {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!isGeneratedRasterMediaType(declaredMediaType)) return null;
  const dimensions = declaredMediaType === "image/png"
    ? inspectPng(bytes)
    : declaredMediaType === "image/jpeg"
      ? inspectJpeg(bytes)
      : declaredMediaType === "image/webp"
        ? inspectWebp(bytes)
        : null;

  if (!dimensions || !validDimensions(dimensions.width, dimensions.height)) {
    return null;
  }
  return {
    mediaType: declaredMediaType,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function isGeneratedRasterMediaType(
  value: string,
): value is GeneratedRasterMediaType {
  return value === "image/jpeg" || value === "image/png" ||
    value === "image/webp";
}

function inspectPng(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 45 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    u32be(bytes, 8) !== 13 ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    return null;
  }
  let offset = 8;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (!type || next > bytes.length) return null;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0) return null;
      sawEnd = next === bytes.length;
      break;
    }
    offset = next;
  }
  if (!sawImageData || !sawEnd) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function inspectJpeg(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    !hasJpegEnd(bytes)
  ) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return null;
      return {
        height: u16be(bytes, offset + 3),
        width: u16be(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    u32le(bytes, 4) + 8 !== bytes.length
  ) {
    return null;
  }
  const chunk = ascii(bytes, 12, 4);
  const chunkLength = u32le(bytes, 16);
  if (20 + chunkLength > bytes.length) return null;
  if (chunk === "VP8X") {
    if (chunkLength < 10) return null;
    return {
      width: 1 + u24le(bytes, 24),
      height: 1 + u24le(bytes, 27),
    };
  }
  if (chunk === "VP8L") {
    if (chunkLength < 5 || bytes[20] !== 0x2f || bytes.length < 25) return null;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (chunk === "VP8 ") {
    if (
      chunkLength < 10 ||
      bytes.length < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return null;
    }
    return {
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }
  return null;
}

function hasJpegEnd(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 &&
    width <= MAX_GENERATED_RASTER_DIMENSION &&
    height <= MAX_GENERATED_RASTER_DIMENSION &&
    width * height <= MAX_GENERATED_RASTER_PIXELS;
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ].includes(marker);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)) >>> 0;
}
