/**
 * The buyer's file upload control, the pure part: what a `file` input (an
 * app's line input on the product page, or a checkout attribute) takes, the
 * checks the browser makes before it sends a file (the API checks again, from
 * the bytes), the answer it keeps (upload ids joined by commas) and the words
 * it shows. The server markup (BuyerUploadField.astro), the checkout renderer
 * (lib/buyer-ui) and the behaviour (control.ts, loaded only where a file input
 * is drawn) share it.
 *
 * Files are buyer content: their names and ids never go in URLs (other than
 * the same-origin DELETE of the buyer's own upload), logs or analytics.
 */
import {
  BUYER_UPLOAD_DECLARATION_LIMITS,
  BUYER_UPLOAD_ID_PATTERN,
  BUYER_UPLOAD_TYPES,
  formatBuyerUploadValue,
  parseBuyerUploadValue,
  type BuyerUploadType,
} from "@scalius/shared/buyer-upload-value";
import type { BuyerUploadCopy } from "@/lib/buyer-upload-copy";
import { formatPageNumber } from "@/lib/store-time-zone";

/** Same-origin endpoints (pages/api/uploads) that pass the file to the API. */
export const BUYER_UPLOAD_ENDPOINT = "/api/uploads";

/** What a file input takes, as the page drew it (the API already bounded it by the plan). */
export interface BuyerUploadField {
  /** The input as the API knows it: `<app id>.<key>`. */
  field: string;
  target: "line" | "attribute";
  /** The product a line input is answered on; null for a checkout attribute. */
  productId: string | null;
  accept: BuyerUploadType[];
  maxBytes: number;
  maxFiles: number;
  required: boolean;
}

function isUploadType(value: unknown): value is BuyerUploadType {
  return (BUYER_UPLOAD_TYPES as readonly unknown[]).includes(value);
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The field from the values the page was given, or null when it can take no
 * file (no field key, a line input without its product). The values are used
 * as sent (the API bounded them by the plan); only the shape is checked: the
 * known types (every one when none is named), a positive size, 1 to 10 files.
 */
export function buyerUploadField(input: {
  field: unknown;
  target: unknown;
  productId?: unknown;
  accept?: unknown;
  maxBytes?: unknown;
  maxFiles?: unknown;
  required?: unknown;
}): BuyerUploadField | null {
  const field = typeof input.field === "string" ? input.field.trim() : "";
  const target = input.target === "line" || input.target === "attribute" ? input.target : null;
  const productId = typeof input.productId === "string" && input.productId.trim() ? input.productId.trim() : null;
  if (!field || field.length > 160 || !target || (target === "line" && !productId)) return null;
  const listed = Array.isArray(input.accept)
    ? input.accept
    : typeof input.accept === "string" ? input.accept.split(",").map((type) => type.trim()) : [];
  const accept = [...new Set(listed.filter(isUploadType))];
  const maxBytes = positiveInteger(input.maxBytes) ?? BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes;
  const maxFiles = Math.min(positiveInteger(input.maxFiles) ?? 1, BUYER_UPLOAD_DECLARATION_LIMITS.maxFiles);
  return {
    field,
    target,
    productId: target === "line" ? productId : null,
    accept: accept.length > 0 ? accept : [...BUYER_UPLOAD_TYPES],
    maxBytes,
    maxFiles,
    required: input.required === true || input.required === "true",
  };
}

/** The data attributes the control's root carries (server markup and the checkout renderer alike). */
export function buyerUploadDataset(field: BuyerUploadField): Record<string, string> {
  return {
    "data-buyer-upload": field.field,
    "data-upload-target": field.target,
    ...(field.productId ? { "data-upload-product": field.productId } : {}),
    "data-upload-accept": field.accept.join(","),
    "data-upload-max-bytes": String(field.maxBytes),
    "data-upload-max-files": String(field.maxFiles),
    ...(field.required ? { "data-upload-required": "true" } : {}),
  };
}

/** The field a control's root describes (`buyerUploadDataset`), or null. */
export function readBuyerUploadDataset(root: { getAttribute(name: string): string | null }): BuyerUploadField | null {
  return buyerUploadField({
    field: root.getAttribute("data-buyer-upload"),
    target: root.getAttribute("data-upload-target"),
    productId: root.getAttribute("data-upload-product"),
    accept: root.getAttribute("data-upload-accept"),
    maxBytes: root.getAttribute("data-upload-max-bytes"),
    maxFiles: root.getAttribute("data-upload-max-files"),
    required: root.getAttribute("data-upload-required"),
  });
}

const TYPE_LABELS: Readonly<Record<BuyerUploadType, string>> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "application/pdf": "PDF",
};

const TYPE_EXTENSIONS: Readonly<Record<BuyerUploadType, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

/** The file picker's `accept`: the types and their extensions (a phone's picker reads either). */
export function buyerUploadAcceptAttribute(accept: readonly BuyerUploadType[]): string {
  return [...accept, ...accept.flatMap((type) => TYPE_EXTENSIONS[type])].join(",");
}

/** "JPG, PNG or PDF". */
export function buyerUploadTypeList(accept: readonly BuyerUploadType[], or: string): string {
  const labels = accept.map((type) => TYPE_LABELS[type]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ${or} ${labels[labels.length - 1]}`;
}

/** A size as the buyer reads it, in the page's digits: "820 KB", "4.5 MB", "20 MB". */
export function formatBuyerUploadSize(bytes: number, language: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe >= 1024 * 1024) {
    const megabytes = Math.round((safe / (1024 * 1024)) * 10) / 10;
    return `${formatPageNumber(megabytes, language)} MB`;
  }
  return `${formatPageNumber(Math.max(1, Math.ceil(safe / 1024)), language)} KB`;
}

/** The line under the control: what it takes, how large, how many. */
export function buyerUploadHint(copy: BuyerUploadCopy, field: BuyerUploadField, language: string): string {
  return copy.hint(
    buyerUploadTypeList(field.accept, copy.or),
    formatBuyerUploadSize(field.maxBytes, language),
    field.maxFiles > 1 ? formatPageNumber(field.maxFiles, language) : null,
  );
}

/** The type the browser says a chosen file is, else its extension's; null when it is none of ours. */
export function buyerUploadFileType(file: { name: string; type: string }): BuyerUploadType | null {
  const declared = file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
  if (isUploadType(declared)) return declared;
  const extension = /\.[A-Za-z0-9]{1,8}$/u.exec(file.name)?.[0]?.toLowerCase();
  if (!extension) return null;
  return BUYER_UPLOAD_TYPES.find((type) => TYPE_EXTENSIONS[type].includes(extension)) ?? null;
}

export type BuyerUploadProblem = "type" | "size" | "count" | "rate" | "unknown" | "failed";

/** Why a chosen file is not sent (its kind, or its size; an empty file is no file of ours), or null. */
export function checkBuyerUploadFile(
  file: { name: string; type: string; size: number },
  field: Pick<BuyerUploadField, "accept" | "maxBytes">,
): "type" | "size" | null {
  const type = buyerUploadFileType(file);
  if (!type || !field.accept.includes(type) || !(file.size > 0)) return "type";
  return file.size > field.maxBytes ? "size" : null;
}

/**
 * What to do with the files the buyer just chose, in their order: each one
 * that passes `checkBuyerUploadFile` is sent while the answer has room
 * (`held`: the files it holds or is sending); the rest say why not.
 */
export function planBuyerUploadSelection<T extends { name: string; type: string; size: number }>(
  files: readonly T[],
  field: Pick<BuyerUploadField, "accept" | "maxBytes" | "maxFiles">,
  held: number,
): { send: T[]; refused: Array<{ file: T; problem: "type" | "size" | "count" }> } {
  const send: T[] = [];
  const refused: Array<{ file: T; problem: "type" | "size" | "count" }> = [];
  for (const file of files) {
    const problem = checkBuyerUploadFile(file, field);
    if (problem) refused.push({ file, problem });
    else if (held + send.length >= field.maxFiles) refused.push({ file, problem: "count" });
    else send.push(file);
  }
  return { send, refused };
}

/** The ids an answer holds (none when it is empty or not an answer). */
export function buyerUploadAnswerIds(value: string | null | undefined, maxFiles: number): string[] {
  const text = (value ?? "").trim();
  if (!text) return [];
  return parseBuyerUploadValue(text, Math.max(1, maxFiles)) ?? [];
}

/** The answer the form sends for these ids: joined by commas, "" for none. */
export function buyerUploadAnswer(ids: readonly string[]): string {
  return ids.length > 0 ? formatBuyerUploadValue(ids) : "";
}

export interface StagedBuyerUpload {
  id: string;
  filename: string;
  sizeBytes: number;
}

/** The stored upload from the API's 201 envelope, or null. */
export function readStagedBuyerUpload(payload: unknown): StagedBuyerUpload | null {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
  const upload = data && typeof data === "object" ? (data as { upload?: unknown }).upload : null;
  if (!upload || typeof upload !== "object") return null;
  const { id, filename, sizeBytes } = upload as Record<string, unknown>;
  if (typeof id !== "string" || !BUYER_UPLOAD_ID_PATTERN.test(id)) return null;
  return {
    id,
    filename: typeof filename === "string" && filename.trim() ? filename.slice(0, 120) : "",
    sizeBytes: typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
  };
}

/** Why the API refused an upload, from its machine fields only (never its prose). */
export function buyerUploadFailure(status: number, payload: unknown): BuyerUploadProblem {
  const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  if (code === "upload_type_not_accepted") return "type";
  if (code === "upload_too_large" || status === 413) return "size";
  if (code === "upload_input_unknown") return "unknown";
  if (status === 429) return "rate";
  return "failed";
}

/** A problem in the page's words. */
export function buyerUploadProblemText(
  copy: BuyerUploadCopy,
  problem: BuyerUploadProblem,
  field: Pick<BuyerUploadField, "accept" | "maxBytes" | "maxFiles">,
  language: string,
): string {
  switch (problem) {
    case "type": return copy.typeNotAccepted(buyerUploadTypeList(field.accept, copy.or));
    case "size": return copy.tooLarge(formatBuyerUploadSize(field.maxBytes, language));
    case "count": return copy.tooMany(formatPageNumber(field.maxFiles, language));
    case "rate": return copy.rateLimited;
    case "unknown": return copy.inputUnknown;
    default: return copy.failed;
  }
}

/** Upload progress as a whole percentage, 0 to 100. */
export function buyerUploadPercent(loaded: number, total: number): number {
  if (!(total > 0) || !(loaded > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)));
}
