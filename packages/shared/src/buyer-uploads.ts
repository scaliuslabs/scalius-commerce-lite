/**
 * Buyer uploads: files a buyer gives an app's `file` line input or checkout
 * attribute (a photo to print, a prescription, a logo to engrave).
 *
 * The buyer's browser sends the file to the API, which sniffs its type from
 * its bytes (never the name or the declared type), stores it privately in R2
 * under `private/buyer-uploads/` and answers an upload id. The answer of a
 * `file` input is the ids of its files joined by commas (`bup_…,bup_…`). The
 * upload is bound to the app, the input and (for a line input) the product it
 * was answered on; the order commit attaches each upload to its order once,
 * so a replayed or swapped id is refused. Uploads never attached are deleted
 * by the scheduled sweep.
 *
 * Uploads are buyer content: never put their bytes, names or links in URLs
 * the buyer did not ask for, logs, analytics or queue payloads.
 */
import { planLimits, type PlanLimits } from "./plan-limits";


/**
 * What an app's admin `file-field` may accept (staff uploading for one of the
 * app's own admin forms, e.g. a CSV import): UTF-8 text, never served inline.
 */
export const ADMIN_UPLOAD_TYPES = ["text/csv"] as const;
export type AdminUploadType = (typeof ADMIN_UPLOAD_TYPES)[number];
/** Every type the upload table stores. */
export type StoredUploadType = BuyerUploadType | AdminUploadType;

export const BUYER_UPLOAD_EXTENSIONS: Readonly<Record<StoredUploadType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
};

/** The R2 prefix; the media hostname never serves `private/`. */
export const BUYER_UPLOAD_R2_PREFIX = "private/buyer-uploads/";
export {
  BUYER_UPLOAD_TYPES,
  buyerUploadDisplayValue,
  type BuyerUploadType,
  BUYER_UPLOAD_DECLARATION_LIMITS,
  BUYER_UPLOAD_ID_PATTERN,
  BUYER_UPLOAD_VALUE_SEPARATOR,
  formatBuyerUploadValue,
  parseBuyerUploadValue,
} from "./buyer-upload-value";
import { BUYER_UPLOAD_DECLARATION_LIMITS, BUYER_UPLOAD_TYPES, type BuyerUploadType } from "./buyer-upload-value";

/**
 * How long an upload waits to be attached to an order before the sweep
 * deletes it: a buyer may leave a cart for a few days.
 */
export const BUYER_UPLOAD_ORPHAN_SECONDS = 72 * 3_600;
/**
 * Order retention: an attached upload is deleted this long after its order
 * was placed, once the order is no longer in progress. The order line keeps
 * its answer; the file reads as no longer kept.
 */
export const BUYER_UPLOAD_RETENTION_DAYS = 365;
/** The most uploads one order holds (the commit refuses more; a list page is at most this). */
export const BUYER_UPLOADS_PER_ORDER_MAX = 50;
/** A signed download link lives this long. */
export const BUYER_UPLOAD_LINK_TTL_SECONDS = 300;
/** HKDF label of the key that signs download links (from SCALIUS_SECRET). */
export const BUYER_UPLOAD_LINK_PURPOSE = "buyer-upload-link";

export function buyerUploadR2Key(uploadId: string): string {
  return `${BUYER_UPLOAD_R2_PREFIX}${uploadId}`;
}

/** A `file` input's declaration, as manifests write it (line inputs and checkout attributes alike). */
export interface BuyerFileInputDeclaration {
  accept?: readonly BuyerUploadType[];
  maxBytes?: number;
  maxFiles?: number;
}

/** What a `file` input accepts on this deployment. */
export interface BuyerFileBounds {
  accept: readonly BuyerUploadType[];
  maxBytes: number;
  maxFiles: number;
}

/**
 * A declaration bounded by the deployment's plan: the declared accept list
 * (every type when absent) and the lower of the declared and the plan's size
 * and count.
 */
export function buyerUploadBounds(
  declaration: BuyerFileInputDeclaration,
  limits: Pick<PlanLimits, "uploads"> = planLimits(),
): BuyerFileBounds {
  const accept = declaration.accept?.length ? [...new Set(declaration.accept)] : [...BUYER_UPLOAD_TYPES];
  return {
    accept,
    maxBytes: Math.min(declaration.maxBytes ?? limits.uploads.maxBytes, limits.uploads.maxBytes),
    maxFiles: Math.min(declaration.maxFiles ?? 1, limits.uploads.maxFiles),
  };
}

/**
 * A declaration as this deployment applies it (server side, where the plan is
 * known): a `file` input's accept list, size and count bounded by the plan.
 * Other declarations pass through. Checkout and the storefront layout read
 * declarations through it, so the buyer's browser draws the bounds the
 * server enforces.
 */
export function withBuyerUploadBounds<T extends { type: string } & BuyerFileInputDeclaration>(
  declaration: T,
  limits: Pick<PlanLimits, "uploads"> = planLimits(),
): T {
  if (declaration.type !== "file") return declaration;
  return { ...declaration, ...buyerUploadBounds(declaration, limits) };
}




function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-
const PDF_EOF = [0x25, 0x25, 0x45, 0x4f, 0x46] as const; // %%EOF

/**
 * The file's type, read from its bytes alone: a JPEG, PNG or WebP signature,
 * or a PDF that starts with `%PDF-` and ends (within its last KiB) with
 * `%%EOF`. Anything else, an HTML or SVG page renamed `.jpg` included, is null.
 */
export function sniffBuyerUploadType(bytes: Uint8Array): BuyerUploadType | null {
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  if (startsWith(bytes, PDF)) {
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - 1_024));
    for (let offset = tail.byteLength - PDF_EOF.length; offset >= 0; offset -= 1) {
      if (startsWith(tail, PDF_EOF, offset)) return "application/pdf";
    }
  }
  return null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * An admin upload's type, read from its bytes alone: text (`text/csv`) when
 * the bytes are valid UTF-8 without NUL or other control characters (tab,
 * line feed, carriage return and form feed allowed) and do not open, after an
 * optional byte-order mark and white space, with markup (`<`): an HTML or SVG
 * page renamed `.csv`, a spreadsheet's binary or an image is null.
 */
export function sniffAdminUploadType(bytes: Uint8Array): AdminUploadType | null {
  if (bytes.byteLength === 0) return null;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) return null;
  }
  const opening = text.replace(/^\uFEFF/u, "").trimStart();
  if (opening.startsWith("<")) return null;
  return "text/csv";
}

/**
 * A safe display name for the file: its last path segment, NFC, with control
 * and path characters removed, at most 120 characters, and the extension of
 * the sniffed type (so the name never claims another type).
 */
export function buyerUploadFilename(name: string | null | undefined, type: StoredUploadType): string {
  const extension = BUYER_UPLOAD_EXTENSIONS[type];
  const base = (name ?? "").normalize("NFC").split(/[\\/]/u).pop() ?? "";
  let clean = "";
  for (const character of base) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || character === "\"" || character === ";") continue;
    clean += character;
  }
  const stem = clean.replace(/\.[A-Za-z0-9]{1,8}$/u, "").trim().replace(/^\.+/u, "") || "file";
  const limit = BUYER_UPLOAD_DECLARATION_LIMITS.filenameLength - extension.length - 1;
  return `${Array.from(stem).slice(0, limit).join("")}.${extension}`;
}

/** The refusal codes of the upload path, the cart and the commit. */
export const BUYER_UPLOAD_ERROR_CODES = [
  "upload_type_not_accepted",
  "upload_too_large",
  "upload_input_unknown",
  "upload_unavailable",
] as const;
export type BuyerUploadErrorCode = (typeof BUYER_UPLOAD_ERROR_CODES)[number];
