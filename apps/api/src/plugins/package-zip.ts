// Reads an uploaded app package (docs/platform/PLUGINS.md, "Upload"): a ZIP
// file holding what `pnpm plugin pack` writes, `manifest.json`, `plugin.js`,
// `assets/*` and, when signed, `signature.json`. Only the ZIP features an
// archiver writes for such a folder are read: stored or deflated entries,
// no encryption, no ZIP64, no multi-part archives. Limits are checked before
// and while inflating, so a small archive cannot expand without bound.

import { PluginError } from "@scalius/core/modules/plugins";

export const PLUGIN_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/-]{1,200}$/;

function invalid(message: string): never {
  throw new PluginError("package.invalid", message);
}

async function inflateRaw(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > expectedSize || size > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      invalid("A file in the package is larger than it says.");
    }
    chunks.push(value);
  }
  if (size !== expectedSize) invalid("A file in the package is damaged.");
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The files of a ZIP archive by path (folders skipped; a top folder shared by every file is removed). */
export async function readPluginPackageZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.byteLength > PLUGIN_PACKAGE_MAX_BYTES) invalid("The package is larger than 20 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) invalid("The file is not a ZIP package.");
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) invalid(`The package holds more than ${MAX_ENTRIES} files.`);
  if (directoryOffset + directorySize > eocd) invalid("The package is damaged.");

  const files = new Map<string, Uint8Array>();
  let total = 0;
  let at = directoryOffset;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) invalid("The package is damaged.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    } catch {
      invalid("A file name in the package is not UTF-8.");
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store") continue;
    if (!SAFE_NAME.test(name)) invalid(`The package holds a file with an unsafe name: ${name.slice(0, 80)}`);
    if (flags & 0x1) invalid("Encrypted packages are not supported.");
    if (method !== 0 && method !== 8) invalid("The package uses an unsupported compression.");
    if (size > MAX_FILE_BYTES || compressedSize > MAX_FILE_BYTES) invalid(`${name} is larger than 16 MiB.`);
    total += size;
    if (total > PLUGIN_PACKAGE_MAX_BYTES) invalid("The package expands to more than 20 MiB.");
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) invalid("The package is damaged.");
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > bytes.byteLength) invalid("The package is damaged.");
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0 && compressedSize !== size) invalid("The package is damaged.");
    files.set(name, method === 0 ? data.slice() : await inflateRaw(data, size));
  }
  // `zip -r acme-app.zip acme-app/` puts every file under one folder.
  const names = [...files.keys()];
  const top = names[0]?.split("/")[0];
  if (top && !files.has("manifest.json") && names.every((name) => name.startsWith(`${top}/`))) {
    return new Map([...files].map(([name, data]) => [name.slice(top.length + 1), data]));
  }
  return files;
}
