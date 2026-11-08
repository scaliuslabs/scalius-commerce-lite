import { parseBuyerUploadValue } from "@scalius/shared/buyer-uploads";
import type { Order } from "./types";

/** The parts of an upload the order page reads. */
export interface BuyerFile {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
  urlExpiresAt: string;
}

/** A link is reused only while this much of its 5 minutes is left, so it cannot lapse on the way to the new tab. */
const LINK_MIN_REMAINING_MS = 60_000;

/** The upload ids of a `file` answer, or null when the text is not one. */
export function answerUploadIds(value: string | null | undefined): string[] | null {
  return value ? parseBuyerUploadValue(value) : null;
}

/**
 * Whether the order holds a file answer (a `file` line property or an
 * attribute that parses as upload ids). Only then does the page ask for the
 * list: a store that does not use uploads pays no request.
 */
export function orderHasUploadAnswers(order: Pick<Order, "items" | "attributes">): boolean {
  for (const item of order.items ?? []) {
    for (const property of item.properties ?? []) {
      if (property.type === "file") return true;
    }
  }
  return Object.values(order.attributes ?? {}).some((value) => answerUploadIds(value) !== null);
}

/** An answer's files in the order the buyer gave them, and how many the list no longer has. */
export function matchUploadAnswer(
  ids: readonly string[],
  uploads: readonly BuyerFile[],
): { files: BuyerFile[]; missing: string[] } {
  const byId = new Map(uploads.map((upload) => [upload.id, upload]));
  const files: BuyerFile[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const upload = byId.get(id);
    if (upload) files.push(upload);
    else missing.push(id);
  }
  return { files, missing };
}

/** Whether the file's signed link still has time to be opened. */
export function linkIsFresh(file: Pick<BuyerFile, "urlExpiresAt">, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(file.urlExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > LINK_MIN_REMAINING_MS;
}

/** "pdf" for a PDF document, otherwise "image". */
export function buyerFileKind(mediaType: string): "pdf" | "image" {
  return mediaType === "application/pdf" ? "pdf" : "image";
}
