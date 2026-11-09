/**
 * A `file` answer's value (its upload ids) and the ceilings a declaration may
 * name: what a buyer page reads to show a line's files. Apart from
 * buyer-uploads.ts, which bounds a declaration by the deployment's plan, so
 * reading a line's words never downloads the plan profile table.
 */

/** What a `file` input may accept: still images and PDF documents. */
export const BUYER_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type BuyerUploadType = (typeof BUYER_UPLOAD_TYPES)[number];

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
