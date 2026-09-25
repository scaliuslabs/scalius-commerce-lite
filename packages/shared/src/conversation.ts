/**
 * Buyer↔store conversation vocabulary and limits (Wave A §4). Pure: the
 * database CHECKs, the API, the dashboard inbox and the storefront thread
 * panel use the same values.
 *
 * Message bodies are buyer and staff content: they never enter URLs, logs,
 * KV keys or queue payloads.
 */

export const CONVERSATION_SUBJECT_TYPES = ["order", "store", "warranty_claim", "review"] as const;
export type ConversationSubjectType = (typeof CONVERSATION_SUBJECT_TYPES)[number];

/** `open` waits on staff, `pending` waits on the buyer, `closed` is done. */
export const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_MESSAGE_KINDS = ["message", "event"] as const;
export type ConversationMessageKind = (typeof CONVERSATION_MESSAGE_KINDS)[number];

/** `internal` messages are staff notes and never reach a buyer projection. */
export const CONVERSATION_MESSAGE_VISIBILITIES = ["public", "internal"] as const;
export type ConversationMessageVisibility = (typeof CONVERSATION_MESSAGE_VISIBILITIES)[number];

export const CONVERSATION_AUTHOR_TYPES = ["customer", "guest_receipt", "staff", "system"] as const;
export type ConversationAuthorType = (typeof CONVERSATION_AUTHOR_TYPES)[number];

export const CONVERSATION_ATTACHMENT_UPLOADER_TYPES = ["customer", "guest_receipt", "staff"] as const;
export type ConversationAttachmentUploaderType = (typeof CONVERSATION_ATTACHMENT_UPLOADER_TYPES)[number];

export const CONVERSATION_ID_PREFIX = "cnv_";
export const CONVERSATION_MESSAGE_ID_PREFIX = "msg_";
export const CONVERSATION_ATTACHMENT_ID_PREFIX = "att_";
export const CONVERSATION_ATTACHMENT_R2_PREFIX = "private/conversations/";

export const CONVERSATION_LIMITS = {
  subjectLength: 120,
  bodyLength: 5_000,
  eventDataLength: 2_000,
  clientMessageKeyLength: 200,
  /** Buyer messages per conversation in any 24 hours. */
  buyerMessagesPerDay: 30,
  /** Open store threads per account. */
  openStoreThreadsPerAccount: 5,
  attachmentsPerMessage: 3,
  attachmentBytes: 5 * 1024 * 1024,
  /** Unattached uploads older than this are swept. */
  orphanAttachmentSeconds: 60 * 60,
  /** Messages per thread page. */
  pageSize: 50,
} as const;

/** Upload types accepted from a browser; every stored attachment is re-encoded WebP. */
export const CONVERSATION_ATTACHMENT_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CONVERSATION_ATTACHMENT_STORED_TYPE = "image/webp" as const;

const OPAQUE_ID_SUFFIX = /^[A-Za-z0-9_-]{8,64}$/;

function hasOpaqueId(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && OPAQUE_ID_SUFFIX.test(value.slice(prefix.length));
}

export function isConversationId(value: unknown): value is string {
  return hasOpaqueId(value, CONVERSATION_ID_PREFIX);
}

export function isConversationAttachmentId(value: unknown): value is string {
  return hasOpaqueId(value, CONVERSATION_ATTACHMENT_ID_PREFIX);
}

export function conversationAttachmentR2Key(conversationId: string, attachmentId: string): string {
  if (!isConversationId(conversationId) || !isConversationAttachmentId(attachmentId)) {
    throw new Error("Conversation attachment key needs opaque conversation and attachment ids.");
  }
  return `${CONVERSATION_ATTACHMENT_R2_PREFIX}${conversationId}/${attachmentId}`;
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

// C0/C1 controls other than tab, line feed and carriage return.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export type ConversationTextResult =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid_characters" };

function normalizeText(input: unknown, maxLength: number, { multiline }: { multiline: boolean }): ConversationTextResult {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const value = input.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (characterLength(value) > maxLength) return { ok: false, reason: "too_long" };
  if (hasControlCharacter(value) || (!multiline && value.includes("\n"))) {
    return { ok: false, reason: "invalid_characters" };
  }
  return { ok: true, value };
}

/** A message body: NFC, CRLF to LF, trimmed, 1–5,000 characters. */
export function normalizeConversationBody(input: unknown): ConversationTextResult {
  return normalizeText(input, CONVERSATION_LIMITS.bodyLength, { multiline: true });
}

/** A store thread subject: one line, 1–120 characters. */
export function normalizeConversationSubject(input: unknown): ConversationTextResult {
  return normalizeText(input, CONVERSATION_LIMITS.subjectLength, { multiline: false });
}

export type ConversationStatusEvent =
  /** A buyer posted a public message: staff need to act, reopening a closed thread. */
  | { type: "buyer_message" }
  /** Staff posted: a public reply waits on the buyer; an internal note changes nothing. */
  | { type: "staff_message"; visibility: ConversationMessageVisibility }
  /** A system event line never changes who the thread waits on. */
  | { type: "system_event" }
  | { type: "close" }
  | { type: "reopen" };

/** The one status rule for posting and staff actions (§4.1). */
export function nextConversationStatus(
  current: ConversationStatus,
  event: ConversationStatusEvent,
): ConversationStatus {
  switch (event.type) {
    case "buyer_message":
      return "open";
    case "staff_message":
      return event.visibility === "public" ? "pending" : current;
    case "system_event":
      return current;
    case "close":
      return "closed";
    case "reopen":
      return current === "closed" ? "open" : current;
  }
}

/** Unread count from the per-thread sequence and a reader's marker: O(1). */
export function conversationUnreadCount(lastSeq: number, readSeq: number): number {
  return Math.max(0, lastSeq - readSeq);
}

/** Buyer projections show public lines only; staff notes never leave the dashboard. */
export function isBuyerVisibleMessage(message: { visibility: ConversationMessageVisibility }): boolean {
  return message.visibility === "public";
}
