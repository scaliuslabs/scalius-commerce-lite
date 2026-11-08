// App uploads (packages/plugin-sdk/docs/apps.md, "Uploads"): a file staff
// give one of an app's admin forms (a `file-field`, e.g. a CSV import). The
// dashboard sends the file to the platform first, which types it from its
// bytes, stores it privately (the buyer-uploads store, `private/buyer-uploads/`)
// bound to the app, and answers an upload id; the form then sends the id as
// the field's value. The app hands the id to a background job
// (`ctx.jobs.start(name, { input: { uploadId } })`, the input stays small)
// and reads the file in bounded slices (`ctx.uploads.read`), one slice per
// step. An app reads only its own uploads. An upload lives until the app
// deletes it (`ctx.uploads.delete`, e.g. when the import is done) or
// `PLUGIN_UPLOAD_LIFETIME_SECONDS` after it was sent, when the platform's
// sweep deletes it. Pure and free of zod: the sandbox wrapper bundles it.
// Part of the versioned plugin API.

import { BUYER_UPLOAD_ID_PATTERN, BUYER_UPLOAD_ORPHAN_SECONDS, type AdminUploadType } from "../buyer-uploads";

/** Upload ids, as `ctx.uploads` takes them: `bup_` and 24 URL-safe characters. */
export const PLUGIN_UPLOAD_ID_PATTERN = BUYER_UPLOAD_ID_PATTERN;
/** The most bytes one `ctx.uploads.read` answers (and its default `length`). */
export const PLUGIN_UPLOAD_READ_MAX_BYTES = 256 * 1024;
/** How long an upload the app never deleted is kept (the platform's sweep then deletes it). */
export const PLUGIN_UPLOAD_LIFETIME_SECONDS = BUYER_UPLOAD_ORPHAN_SECONDS;

/** One of the app's uploads (`ctx.uploads.get`). */
export interface PluginUpload {
  id: string;
  /** The name staff's file had, cleaned, with the extension of its type. */
  filename: string;
  /** Typed from the bytes: `text/csv` is UTF-8 text without control characters or markup. */
  mediaType: AdminUploadType;
  sizeBytes: number;
  /** The admin route whose form took it. */
  route: string;
  /** ISO 8601. */
  createdAt: string;
  /** When the platform deletes it unless the app deleted it before (ISO 8601). */
  expiresAt: string;
}

/** One slice of a text upload (`ctx.uploads.read`). */
export interface PluginUploadSlice {
  /** The slice as text (a byte-order mark at the start of the file left out). */
  text: string;
  /** The byte offset the slice starts at. */
  offset: number;
  /** Where the next slice starts: pass it as `offset` (equals `sizeBytes` when `done`). */
  nextOffset: number;
  /** The slice reaches the end of the file. */
  done: boolean;
  sizeBytes: number;
}

const LINE_FEED = 0x0a;

/** Whether a byte starts a UTF-8 character (any byte but a continuation byte). */
function startsCharacter(byte: number): boolean {
  return (byte & 0xc0) !== 0x80;
}

/** The length of the UTF-8 sequence a lead byte opens. */
function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  return 4;
}

/**
 * Where a slice of `window` (the bytes from `offset`, at most the read's
 * length) ends: the whole window at the end of the file; otherwise just after
 * its last line feed, so every slice holds whole lines (a quoted CSV field
 * that spans lines is the app's to carry over); a window without a line
 * feed ends at its last whole UTF-8 character.
 */
export function pluginUploadSliceEnd(window: Uint8Array, atEnd: boolean): number {
  if (atEnd) return window.byteLength;
  const lastLineFeed = window.lastIndexOf(LINE_FEED);
  if (lastLineFeed >= 0) return lastLineFeed + 1;
  let lead = window.byteLength - 1;
  while (lead > 0 && !startsCharacter(window[lead]!)) lead -= 1;
  if (lead < 0) return 0;
  return lead + sequenceLength(window[lead]!) <= window.byteLength ? window.byteLength : lead;
}

const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf] as const;

/**
 * The slice `ctx.uploads.read` answers for the bytes read at `offset` (the
 * host and the test harness share it). `null` when `offset` falls inside a
 * character (never a `nextOffset` the platform answered).
 */
export function pluginUploadSlice(window: Uint8Array, offset: number, sizeBytes: number): PluginUploadSlice | null {
  if (window.byteLength > 0 && !startsCharacter(window[0]!)) return null;
  const atEnd = offset + window.byteLength >= sizeBytes;
  const end = pluginUploadSliceEnd(window, atEnd);
  let body = window.subarray(0, end);
  if (offset === 0 && BYTE_ORDER_MARK.every((byte, index) => body[index] === byte)) body = body.subarray(BYTE_ORDER_MARK.length);
  const nextOffset = offset + end;
  return { text: new TextDecoder().decode(body), offset, nextOffset, done: nextOffset >= sizeBytes, sizeBytes };
}

/** The read's checked bounds, or a message for `uploads_invalid`. */
export function pluginUploadReadBounds(options: unknown): { ok: true; offset: number; length: number } | { ok: false; message: string } {
  const value = (options ?? {}) as { offset?: unknown; length?: unknown };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "options is { offset?, length? }." };
  const offset = value.offset ?? 0;
  const length = value.length ?? PLUGIN_UPLOAD_READ_MAX_BYTES;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return { ok: false, message: "offset is a whole number of bytes, from 0." };
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 4 || length > PLUGIN_UPLOAD_READ_MAX_BYTES) {
    return { ok: false, message: `length is 4 to ${PLUGIN_UPLOAD_READ_MAX_BYTES} bytes.` };
  }
  return { ok: true, offset, length };
}
