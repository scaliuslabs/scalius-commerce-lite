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

/** What a `file` input may accept: still images and PDF documents. */
export const BUYER_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type BuyerUploadType = (typeof BUYER_UPLOAD_TYPES)[number];

export const BUYER_UPLOAD_EXTENSIONS: Readonly<Record<BuyerUploadType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** The R2 prefix; the media hostname never serves `private/`. */
export const BUYER_UPLOAD_R2_PREFIX = "private/buyer-uploads/";
/** Upload ids: `bup_` and 24 URL-safe characters (144 random bits). */
export const BUYER_UPLOAD_ID_PATTERN = /^bup_[A-Za-z0-9_-]{24}$/u;
/** The separator of a `file` answer's ids. */
export const BUYER_UPLOAD_VALUE_SEPARATOR = ",";

/**
 * The absolute ceilings a manifest may declare (the Paid plan's). The
 * deployment's plan bounds them again at run time (`buyerUploadBounds`): the
 * platform takes the lower value, as it does for an app's `limits`.
 */
export const BUYER_UPLOAD_DECLARATION_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxFiles: 10,
  filenameLength: 120,
} as const;

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

/**
 * The upload ids of a `file` answer, or null when it is not one: one to
 * `maxFiles` distinct ids joined by commas.
 */
export function parseBuyerUploadValue(value: string, maxFiles: number = BUYER_UPLOAD_DECLARATION_LIMITS.maxFiles): string[] | null {
  const ids = value.split(BUYER_UPLOAD_VALUE_SEPARATOR).map((id) => id.trim());
  if (ids.length < 1 || ids.length > maxFiles) return null;
  if (!ids.every((id) => BUYER_UPLOAD_ID_PATTERN.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

export function formatBuyerUploadValue(ids: readonly string[]): string {
  return ids.join(BUYER_UPLOAD_VALUE_SEPARATOR);
}

/** What the order line shows for a `file` answer until the file names are read. */
export function buyerUploadDisplayValue(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
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

/**
 * A safe display name for the file: its last path segment, NFC, with control
 * and path characters removed, at most 120 characters, and the extension of
 * the sniffed type (so the name never claims another type).
 */
export function buyerUploadFilename(name: string | null | undefined, type: BuyerUploadType): string {
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
