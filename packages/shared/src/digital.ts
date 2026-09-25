/**
 * Digital products (Wave B §3): delivery limits, upload geometry, download
 * filenames and licence-key import. Pure, shared by the API, the dashboard and
 * the storefront.
 *
 * Licence keys are secrets: never put them in URLs, logs, analytics, outbox
 * payloads or delivery receipts. Staff see `last4` only after import.
 */

export const DIGITAL_ASSET_KINDS = ["file", "licence_keys"] as const;
export type DigitalAssetKind = (typeof DIGITAL_ASSET_KINDS)[number];

export const DIGITAL_UPLOAD_STATUSES = ["uploading", "complete", "aborted"] as const;
export type DigitalUploadStatus = (typeof DIGITAL_UPLOAD_STATUSES)[number];

export const LICENCE_KEY_STATUSES = ["available", "assigned", "revoked"] as const;
export type LicenceKeyStatus = (typeof LICENCE_KEY_STATUSES)[number];

/** Downloads per entitlement: default 5; 1–100, or `null` for unlimited. */
export const DIGITAL_DOWNLOAD_LIMIT_DEFAULT = 5;
export const DIGITAL_DOWNLOAD_LIMIT_MIN = 1;
export const DIGITAL_DOWNLOAD_LIMIT_MAX = 100;
/** Days of access after delivery: 1–3650, or `null` for forever (the default). */
export const DIGITAL_ACCESS_DAYS_MIN = 1;
export const DIGITAL_ACCESS_DAYS_MAX = 3_650;

export const DIGITAL_MAX_FILE_ASSETS_PER_VARIANT = 10;
export const DIGITAL_MAX_KEY_POOLS_PER_VARIANT = 1;

/**
 * R2 multipart geometry: fixed 50 MiB parts (the last may be shorter), at most
 * 40 parts. The file cap is defined from the part count so the two can never
 * disagree: 40 x 50 MiB = 2,097,152,000 bytes (the design's "2 GiB" rounded;
 * a true 2 GiB would need 41 parts).
 */
export const DIGITAL_UPLOAD_PART_BYTES = 50 * 1024 * 1024;
export const DIGITAL_MAX_UPLOAD_PARTS = 40;
export const DIGITAL_MAX_FILE_BYTES = DIGITAL_MAX_UPLOAD_PARTS * DIGITAL_UPLOAD_PART_BYTES;
/** Upload sessions older than this are aborted by the sweep. */
export const DIGITAL_UPLOAD_STALE_SECONDS = 24 * 60 * 60;

/** Every digital object lives under this never-served prefix (`private/` is refused by the media server). */
export const DIGITAL_R2_PREFIX = "private/digital/";

/** Download tickets live 10 minutes; resuming within that window does not count again. */
export const DIGITAL_DOWNLOAD_TICKET_TTL_SECONDS = 600;
/** HMAC purpose for download tickets (key derived from `SCALIUS_SECRET`; short-lived, so rotation is harmless). */
export const DIGITAL_DOWNLOAD_TICKET_PURPOSE = "digital-download-ticket";

export const LICENCE_KEY_MAX_LENGTH = 200;
export const LICENCE_KEY_IMPORT_MAX_KEYS = 500;
/** HMAC purpose for `digital_licence_keys.key_hash` (key derived from `CREDENTIAL_ENCRYPTION_KEY`). */
export const LICENCE_KEY_HASH_PURPOSE = "digital-licence-key-hash-v1";
/** AES-GCM purpose for `digital_licence_keys.key_ciphertext` (key derived from `CREDENTIAL_ENCRYPTION_KEY`). */
export const LICENCE_KEY_CIPHER_PURPOSE = "digital-licence-key-v1";

export function isDigitalAssetKind(value: unknown): value is DigitalAssetKind {
  return typeof value === "string" && (DIGITAL_ASSET_KINDS as readonly string[]).includes(value);
}

/** `null` (unlimited) or an integer 1–100. */
export function isDigitalDownloadLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value)
    && value >= DIGITAL_DOWNLOAD_LIMIT_MIN && value <= DIGITAL_DOWNLOAD_LIMIT_MAX);
}

/** `null` (forever) or an integer 1–3650. */
export function isDigitalAccessDays(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value)
    && value >= DIGITAL_ACCESS_DAYS_MIN && value <= DIGITAL_ACCESS_DAYS_MAX);
}

/** Parts a file of `sizeBytes` needs, or `null` when it is empty or over `DIGITAL_MAX_FILE_BYTES`. */
export function digitalUploadPartCount(sizeBytes: number): number | null {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > DIGITAL_MAX_FILE_BYTES) return null;
  return Math.ceil(sizeBytes / DIGITAL_UPLOAD_PART_BYTES);
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `private/digital/<assetId>/<uploadId>`; ids must be opaque (letters, digits, `_`, `-`). */
export function digitalObjectKey(assetId: string, uploadId: string): string {
  if (!OPAQUE_ID.test(assetId) || !OPAQUE_ID.test(uploadId)) {
    throw new Error("A digital object key needs opaque asset and upload ids.");
  }
  return `${DIGITAL_R2_PREFIX}${assetId}/${uploadId}`;
}

// ---------------------------------------------------------------------------
// Download filenames

/** Longest sanitized filename, in code points (extension included). */
export const DOWNLOAD_FILENAME_MAX_LENGTH = 150;
const FALLBACK_FILENAME = "download";

/**
 * Characters removed from download names (besides C0/C1 controls): the Windows-reserved
 * `<>:"/\|?*`, and invisible or bidi format controls that can disguise an
 * extension ("photo" + U+202E + "gnp.exe"). ZWJ/ZWNJ stay: Bangla spelling
 * uses them.
 */
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;
/** Unpaired UTF-16 surrogates (not encodable: `encodeURIComponent` throws on them). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const EXTENSION = /\.[\p{L}\p{N}]{1,16}$/u;

/** C0 and C1 control characters (and DEL). */
function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

/**
 * A safe download name: the last path segment (after `/` or `\`), NFC, unsafe
 * characters dropped, whitespace collapsed, leading/trailing dots and spaces
 * trimmed, at most 150 characters with the extension kept when the stem is
 * shortened. Falls back to "download" (keeping a lone extension: ".pdf" →
 * "download.pdf").
 */
export function sanitizeDownloadFilename(name: string | null | undefined): string {
  const raw = typeof name === "string" ? name : "";
  const segment = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = segment
    .replace(LONE_SURROGATE, "")
    .normalize("NFC")
    .replace(/[^]/gu, (character) => (isControlCode(character.codePointAt(0)!) ? "" : character))
    .replace(UNSAFE_FILENAME_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  const extensionMatch = EXTENSION.exec(cleaned);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const stem = cleaned
    .slice(0, cleaned.length - extension.length)
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  const safeStem = stem || FALLBACK_FILENAME;
  const room = DOWNLOAD_FILENAME_MAX_LENGTH - codePoints(extension).length;
  const trimmedStem = codePoints(safeStem).slice(0, room).join("").replace(/[.\s]+$/u, "") || FALLBACK_FILENAME;
  return `${trimmedStem}${extension}`;
}

/** RFC 5987 `attr-char` percent-encoding: `encodeURIComponent` also leaves `'()*!` bare. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `Content-Disposition` for a download (RFC 6266): always `attachment`, an
 * ASCII `filename="…"` fallback (non-ASCII and `%` become `_`) and the exact
 * sanitized name as `filename*=UTF-8''…`.
 */
export function contentDispositionAttachment(name: string | null | undefined): string {
  const filename = sanitizeDownloadFilename(name);
  const asciiFallback = filename.replace(/[^\x20-\x7E]|%/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

// ---------------------------------------------------------------------------
// Licence keys

export type LicenceKeyRejectReason = "too_long" | "invalid_characters" | "duplicate";

export interface LicenceKeyImportReject {
  /** 1-based line number in the pasted text. The key itself is never echoed back. */
  line: number;
  reason: LicenceKeyRejectReason;
}

export interface LicenceKeyImport {
  /** Unique keys in first-seen order, at most `LICENCE_KEY_IMPORT_MAX_KEYS`. */
  keys: string[];
  rejects: LicenceKeyImportReject[];
  /** More than 500 valid unique keys: callers refuse the request (ask for smaller files) rather than import a prefix. */
  exceedsLimit: boolean;
}

/** The first CSV column of one line: a quoted field (with `""` escapes) or the text before the first comma. */
function firstCsvColumn(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('"')) {
    const comma = trimmed.indexOf(",");
    return comma === -1 ? trimmed : trimmed.slice(0, comma);
  }
  let value = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === '"') {
      if (trimmed[index + 1] === '"') {
        value += '"';
        index += 1;
        continue;
      }
      return value;
    }
    value += character;
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCode(value.charCodeAt(index))) return true;
  }
  return false;
}

/**
 * Pasted or uploaded keys → the keys to import. One key per line (LF or CRLF);
 * for CSV, the first column. Each key is NFC-normalized and trimmed; blank lines
 * are skipped; keys over 200 characters or with control characters are
 * rejected; repeats are dropped keeping the first (case-sensitive: keys are
 * exact strings). A header row is imported like any other line; the pool's
 * hash dedupe still refuses keys already imported.
 */
export function normalizeLicenceKeyImport(text: string): LicenceKeyImport {
  const keys: string[] = [];
  const rejects: LicenceKeyImportReject[] = [];
  const seen = new Set<string>();
  let exceedsLimit = false;
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const key = firstCsvColumn(lines[index]!).normalize("NFC").trim();
    if (!key) continue;
    const line = index + 1;
    if (hasControlCharacter(key)) {
      rejects.push({ line, reason: "invalid_characters" });
    } else if (codePoints(key).length > LICENCE_KEY_MAX_LENGTH) {
      rejects.push({ line, reason: "too_long" });
    } else if (seen.has(key)) {
      rejects.push({ line, reason: "duplicate" });
    } else if (keys.length === LICENCE_KEY_IMPORT_MAX_KEYS) {
      exceedsLimit = true;
    } else {
      seen.add(key);
      keys.push(key);
    }
  }
  return { keys, rejects, exceedsLimit };
}

/**
 * The visible tail of a key (`key_last4`): the last 4 characters, but never
 * more than half the key, so a short key is not shown whole.
 */
export function licenceKeyLast4(key: string): string {
  const characters = codePoints(key.normalize("NFC").trim());
  const visible = Math.min(4, Math.floor(characters.length / 2));
  return visible > 0 ? characters.slice(-visible).join("") : "";
}

/** `•••• ABCD` from a full key or the stored `key_last4` (≤ 4 characters is taken as `last4`). */
export function maskLicenceKey(keyOrLast4: string): string {
  const trimmed = keyOrLast4.normalize("NFC").trim();
  const last4 = codePoints(trimmed).length <= 4 ? trimmed : licenceKeyLast4(trimmed);
  return last4 ? `•••• ${last4}` : "••••";
}
