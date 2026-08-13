import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { CliError } from "./errors.js";
import { findOperation, getIndexedOperations } from "./openapi.js";
import { executeOperation } from "./operations.js";
import { writeDiagnostic } from "./output.js";
import type { OperationExecutionResult, ResolvedProfile, Runtime } from "./types.js";

const MIB = 1024 * 1024;
const SIGNATURE_BYTES = 4096;
const MEDIA_POLICY = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], maximumBytes: 20 * MIB },
  "image/png": { extensions: [".png"], maximumBytes: 20 * MIB },
  "image/gif": { extensions: [".gif"], maximumBytes: 20 * MIB },
  "image/webp": { extensions: [".webp"], maximumBytes: 20 * MIB },
  "image/avif": { extensions: [".avif"], maximumBytes: 20 * MIB },
  "video/mp4": { extensions: [".mp4"], maximumBytes: 100 * MIB },
  "video/webm": { extensions: [".webm"], maximumBytes: 100 * MIB },
} as const;
type MediaMime = keyof typeof MEDIA_POLICY;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function detectMime(bytes: Uint8Array): MediaMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(bytes, 4, bytes.length - 4).toLowerCase().includes("webm")) return "video/webm";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brands = ascii(bytes, 8, Math.min(bytes.length - 8, 64));
    if (/avif|avis/u.test(brands)) return "image/avif";
    if (/isom|iso[256]|mp4[12]|avc1|m4v |3gp[456]|dash|msnv/iu.test(brands)) return "video/mp4";
  }
  return null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(8, "invalid_response", `Upload ${label} response is invalid.`);
  return value as Record<string, unknown>;
}

function responseData(result: OperationExecutionResult): Record<string, unknown> {
  return record(record(result.data, "operation").data, "data");
}

async function inspectFile(path: string) {
  const file = await open(path, "r").catch(() => { throw new CliError(5, "file_read_failed", `Unable to read media file '${path}'.`); });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1) throw new CliError(5, "invalid_media", `Media file '${path}' is empty or not a regular file.`);
    const signature = Buffer.alloc(Math.min(metadata.size, SIGNATURE_BYTES));
    await file.read(signature, 0, signature.length, 0);
    const mimeType = detectMime(signature);
    if (!mimeType) throw new CliError(5, "unsupported_media", `Unsupported media '${path}'. Use JPEG, PNG, GIF, WebP, AVIF, MP4, or WebM; convert HEIC/HEIF, TIFF, BMP, and SVG first.`);
    const policy = MEDIA_POLICY[mimeType];
    const extension = extname(path).toLowerCase();
    if (!(policy.extensions as readonly string[]).includes(extension)) throw new CliError(5, "media_extension_mismatch", `File '${path}' is ${mimeType} but uses '${extension || "no extension"}'. Rename it to ${policy.extensions.join(" or ")}.`);
    if (metadata.size > policy.maximumBytes) throw new CliError(5, "media_too_large", `File '${path}' exceeds the ${policy.maximumBytes / MIB} MiB limit for ${mimeType}.`);
    return { filename: basename(path), mimeType, size: metadata.size };
  } finally {
    await file.close();
  }
}

export async function uploadMediaFiles(runtime: Runtime, profile: ResolvedProfile, paths: string[], folderId?: string): Promise<Record<string, unknown>> {
  if (paths.length < 1 || paths.length > 50) throw new CliError(5, "invalid_media_count", "Upload between 1 and 50 media files.");
  const { document, operations } = await getIndexedOperations(runtime, profile);
  const initiate = findOperation(operations, "dashboard.media.upload_initiate");
  const uploadPart = findOperation(operations, "dashboard.media.upload_part");
  const complete = findOperation(operations, "dashboard.media.upload_complete");
  const abort = findOperation(operations, "dashboard.media.upload_abort");
  const partBytes = uploadPart.agent.maxRequestBytes;
  if (!Number.isSafeInteger(partBytes) || !partBytes || partBytes > 5 * MIB) throw new CliError(8, "invalid_openapi", "Media upload part policy is invalid.");
  const temporary = await mkdtemp(join(tmpdir(), "scalius-media-"));
  const uploaded: Record<string, unknown>[] = [];
  try {
    for (const [fileIndex, path] of paths.entries()) {
      const metadata = await inspectFile(path);
      writeDiagnostic(runtime, `Uploading ${fileIndex + 1}/${paths.length}: ${metadata.filename} (${metadata.size} bytes).`);
      const initiated = await executeOperation(runtime, profile, document, initiate, { input: { body: { ...metadata, ...(folderId ? { folderId } : {}) } }, files: [], yes: true, overwrite: false });
      const session = record(responseData(initiated).session, "session");
      const sessionId = String(session.id ?? "");
      const expectedParts = Number(session.expectedParts);
      if (!sessionId || expectedParts !== Math.ceil(metadata.size / partBytes) || Number(session.partSize) !== partBytes) throw new CliError(8, "invalid_response", "Upload session bounds do not match the live upload contract.");
      try {
        const source = await open(path, "r");
        try {
          for (let partNumber = 1; partNumber <= expectedParts; partNumber += 1) {
            const offset = (partNumber - 1) * partBytes;
            const size = Math.min(partBytes, metadata.size - offset);
            const bytes = Buffer.allocUnsafe(size);
            const read = await source.read(bytes, 0, size, offset);
            if (read.bytesRead !== size) throw new CliError(5, "file_changed", `Media file '${path}' changed while uploading.`);
            const partPath = join(temporary, `${fileIndex}-${partNumber}.part`);
            await writeFile(partPath, bytes, { flag: "wx", mode: 0o600 });
            await executeOperation(runtime, profile, document, uploadPart, { input: { path: { id: sessionId, partNumber } }, files: [partPath], yes: true, overwrite: false });
            await rm(partPath, { force: true });
          }
        } finally { await source.close(); }
        const committed = await executeOperation(runtime, profile, document, complete, { input: { path: { id: sessionId } }, files: [], yes: true, overwrite: false });
        const file = record(responseData(committed).file, "file");
        uploaded.push({ path, filename: metadata.filename, mediaId: file.id, mimeType: file.mimeType, size: file.size });
      } catch (error) {
        await executeOperation(runtime, profile, document, abort, { input: { path: { id: sessionId } }, files: [], yes: true, overwrite: false }).catch(() => undefined);
        throw error;
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { uploaded, count: uploaded.length };
}
