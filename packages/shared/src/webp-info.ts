/**
 * Structure check and dimensions of a still WebP file, read from its header
 * alone (no decoder). The API stores chat attachments exactly as the browser
 * pipeline encoded them, so it accepts a file only when the RIFF container is
 * well formed end to end: the declared size matches the byte count (no data
 * trailing the image), the first chunk is a still-image chunk, and its size
 * fields are readable.
 */

export interface WebpInfo {
  width: number;
  height: number;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function u24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

/** Width and height of a well-formed, non-animated WebP, or null for anything else. */
export function readStillWebp(bytes: Uint8Array): WebpInfo | null {
  if (bytes.byteLength < 30 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return null;
  if (u32(bytes, 4) + 8 !== bytes.byteLength) return null;
  const chunk = fourcc(bytes, 12);
  const size = u32(bytes, 16);
  if (20 + size > bytes.byteLength) return null;
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    if (size < 10 || (bytes[20]! & 0x02) !== 0) return null; // animation flag
    width = u24(bytes, 24) + 1;
    height = u24(bytes, 27) + 1;
  } else if (chunk === "VP8L") {
    if (size < 5 || bytes[20] !== 0x2f) return null;
    const packed = u32(bytes, 21);
    width = (packed & 0x3fff) + 1;
    height = ((packed >>> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8 ") {
    // Frame tag (3 bytes), start code 9d 01 2a, then two 14-bit sizes.
    if (size < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
  } else {
    return null;
  }
  return width > 0 && height > 0 ? { width, height } : null;
}
