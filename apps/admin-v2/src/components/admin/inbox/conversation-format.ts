// Pure presentation rules for conversations: titles, list previews, event
// lines and author names. Shared by the inbox and the order page card.
import type { InboxMessageKey } from "~/i18n/inbox";

type T = (key: InboxMessageKey, vars?: Record<string, string | number>) => string;

export interface ThreadTitleSource {
  subjectType: string;
  subject: string | null;
  orderNumber: string | null;
}

/** "Order #1057" for order threads, the subject for store threads. */
export function threadTitle(t: T, thread: ThreadTitleSource): string {
  if (thread.subjectType === "order" && thread.orderNumber) return t("orderThread", { number: thread.orderNumber });
  return thread.subject?.trim() || t("storeThread");
}

/** The list's second line: the last text, or who acted last when it was an event or an image. */
export function threadPreview(
  t: T,
  item: { preview: string | null; lastAuthorType: string | null },
): string {
  if (item.preview) return item.preview;
  switch (item.lastAuthorType) {
    case "customer":
    case "guest_receipt":
    case "staff":
    case "system":
      return t(`last.${item.lastAuthorType}`);
    default:
      return "";
  }
}

export interface EventSource {
  eventKind: string | null;
  eventData: Record<string, unknown> | null;
}

/**
 * One system line: a case submitted or its status changing. `requestLabel`
 * and `statusLabel` come from the order catalogs so the words match the
 * order page.
 */
export function eventText(
  t: T,
  event: EventSource,
  labels: { request: (type: string) => string; status: (status: string) => string },
): string {
  const data = event.eventData ?? {};
  const type = typeof data.type === "string" ? data.type : "";
  if (event.eventKind === "support_request_submitted") {
    return t("event.support_request_submitted", { request: labels.request(type) });
  }
  if (event.eventKind === "support_request_status") {
    const status = typeof data.toStatus === "string" ? data.toStatus : "";
    return t("event.support_request_status", { request: labels.request(type), status: labels.status(status) });
  }
  return t("event.other");
}

export function authorName(
  t: T,
  message: { authorType: string; authorUserId: string | null; authorName: string | null },
  currentUserId: string | null,
  customerName: string | null,
): string {
  if (message.authorType === "staff") {
    if (currentUserId && message.authorUserId === currentUserId) return t("you");
    return message.authorName?.trim() || t("staffFallback");
  }
  if (message.authorType === "customer" || message.authorType === "guest_receipt") {
    return customerName?.trim() || t("unknownCustomer");
  }
  return "";
}

/** Initials for the avatar: first letters of the first two words, never splitting a Bangla cluster. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  return words
    .map((word) => (segmenter ? segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? "" : word.charAt(0)))
    .join("")
    .toUpperCase();
}

export const MAX_BODY_LENGTH = 5_000;
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ImageRejection = "attachTooMany" | "attachTooBig" | "attachType";

/** Which picked files may be uploaded next to `alreadyAttached`, and why the rest can't. */
export function acceptImages(files: readonly File[], alreadyAttached: number): { accepted: File[]; rejection: ImageRejection | null } {
  const accepted: File[] = [];
  let rejection: ImageRejection | null = null;
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type)) {
      rejection ??= "attachType";
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejection ??= "attachTooBig";
      continue;
    }
    if (alreadyAttached + accepted.length >= MAX_IMAGES) {
      rejection ??= "attachTooMany";
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejection };
}
