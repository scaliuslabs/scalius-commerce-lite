/**
 * D1 caps one bound value at 2,000,000 bytes. A list bound as one JSON value
 * (read with `json_each`) is split well below that, one statement a part.
 */
export const MAX_JSON_VALUE_BYTES = 256 * 1024;

/** `items` as JSON array texts, each at most `maxBytes` (an item larger than that is a part alone). */
export function jsonChunks<T>(items: readonly T[], maxBytes = MAX_JSON_VALUE_BYTES): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const text = JSON.stringify(item);
    const size = encoder.encode(text).byteLength + 1;
    if (parts.length > 0 && bytes + size > maxBytes) {
      chunks.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 2;
    }
    parts.push(text);
    bytes += size;
  }
  if (parts.length > 0) chunks.push(`[${parts.join(",")}]`);
  return chunks;
}
