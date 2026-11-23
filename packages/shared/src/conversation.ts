/**
 * Buyer↔store conversation vocabulary and limits (Wave A §4). Pure: the
 * database CHECKs, the API, the dashboard inbox and the storefront thread
 * panel use the same values.
 *
 * Message bodies are buyer and staff content: they never enter URLs, logs,
 * KV keys or queue payloads.
 */

import { defineMachine } from "./machine";

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

export const CONVERSATION_ID_PREFIX = "cnv_";
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
  productsPerMessage: 3,
} as const;

export interface ConversationProductReference { productId: string; skuId: string }
/** Names are fallback display snapshots only; prices and availability are always live. */
export interface ConversationProductSnapshot extends ConversationProductReference {
  title: string;
  variantLabel: string | null;
}
export interface ConversationProductCard extends ConversationProductSnapshot {
  status: "available" | "sold_out" | "unavailable";
  price: { amount: number; currency: string } | null;
  imageUrl: string | null;
  pdpUrl: string | null;
}

/** Defensive read of the public product-reply payload; rejects partial/malformed legacy data. */
export function conversationProductSnapshots(data: unknown): ConversationProductSnapshot[] {
  if (!data || typeof data !== "object") return [];
  const value = data as { v?: unknown; cards?: unknown };
  if (value.v !== 1 || !Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 3) return [];
  const ids = new Set<string>();
  const cards: ConversationProductSnapshot[] = [];
  for (const card of value.cards) {
    if (!card || typeof card !== "object") return [];
    const { productId, skuId, title, variantLabel } = card as Record<string, unknown>;
    if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(productId)
      || typeof skuId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(skuId)
      || ids.has(skuId) || typeof title !== "string" || !title.trim() || [...title].length > 160
      || (variantLabel !== null && (typeof variantLabel !== "string" || [...variantLabel].length > 80))) return [];
    ids.add(skuId);
    cards.push({ productId, skuId, title, variantLabel });
  }
  return cards;
}

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

/** Who makes a status move: the buyer (signed in or holding the order's receipt) or staff (and apps on their behalf). */
export type ConversationStatusActor = "buyer" | "staff";

/**
 * The one status machine of a conversation. A buyer's message (re)opens it
 * for the store, a public staff reply leaves it waiting on the buyer; staff
 * mark it waiting or needing the store, and staff or the buyer close it. No
 * state is final: a new message reopens a closed conversation. Internal
 * notes and event lines move nothing. Every writer names a move and its
 * update names the move's source states (`conversationStatusMove`).
 */
export const CONVERSATION_MACHINE = defineMachine({
  name: "conversation",
  states: CONVERSATION_STATUSES,
  initial: ["open"],
  final: [],
  moves: {
    // A move's sources never include its target: a message to a thread already in it moves nothing.
    buyer_message: { from: ["pending", "closed"], to: "open", by: ["buyer"] },
    staff_reply: { from: ["open", "closed"], to: "pending", by: ["staff"] },
    await_buyer: { from: ["open", "closed"], to: "pending", by: ["staff"] },
    reopen: { from: ["pending", "closed"], to: "open", by: ["staff"] },
    close: { from: ["open", "pending"], to: "closed", by: ["staff", "buyer"] },
  },
});

export type ConversationStatusMove = keyof typeof CONVERSATION_MACHINE.moves & string;

/** The moves staff choose by their target in the inbox (a reply moves by `staff_reply`). */
const STAFF_STATUS_MOVES: Readonly<Record<ConversationStatus, ConversationStatusMove>> = {
  open: "reopen",
  pending: "await_buyer",
  closed: "close",
};

/** The move staff make to put a conversation in `status`. */
export function staffStatusMove(status: ConversationStatus): ConversationStatusMove {
  return STAFF_STATUS_MOVES[status];
}

/** A move's target and the states it may leave from: the write names them (`status IN from`). */
export function conversationStatusMove(move: ConversationStatusMove): { to: ConversationStatus; from: readonly ConversationStatus[] } {
  const declared = CONVERSATION_MACHINE.moves[move];
  return { to: declared.to, from: declared.from };
}

// ── Topics ────────────────────────────────────────────────────────────────

/**
 * A topic the merchant lists for buyer conversations ("Payment", "Delivery"):
 * a stable key the conversation keeps, a label in the store's default
 * language, and its labels in the store's other languages (by two-letter
 * code), edited with the list. A reader in a language with no label of its
 * own reads `label`.
 */
export interface ConversationTopic {
  key: string;
  label: string;
  labels?: Record<string, string>;
}

export const CONVERSATION_TOPIC_LIMITS = { topics: 12, keyLength: 40, labelLength: 60, languages: 20 } as const;

/** A topic's label in `locale` (a two-letter language), else its default label. */
export function conversationTopicLabel(topic: ConversationTopic, locale: string | null | undefined): string {
  return (locale && topic.labels?.[locale]) || topic.label;
}

const TOPIC_KEY = /^[a-z0-9](?:[a-z0-9_-]{0,39})$/;

export function isConversationTopicKey(value: unknown): value is string {
  return typeof value === "string" && TOPIC_KEY.test(value);
}

export type ConversationTopicsResult =
  | { ok: true; value: ConversationTopic[] }
  | { ok: false; reason: "too_many" | "invalid_key" | "duplicate_key" | "invalid_label"; index?: number };

/** The merchant's topic list: at most 12, each a unique key (a-z, 0-9, `_`, `-`) and a one-line label. */
export function normalizeConversationTopics(input: unknown): ConversationTopicsResult {
  if (!Array.isArray(input)) return { ok: true, value: [] };
  if (input.length > CONVERSATION_TOPIC_LIMITS.topics) return { ok: false, reason: "too_many" };
  const seen = new Set<string>();
  const topics: ConversationTopic[] = [];
  for (const [index, raw] of input.entries()) {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!isConversationTopicKey(key)) return { ok: false, reason: "invalid_key", index };
    if (seen.has(key)) return { ok: false, reason: "duplicate_key", index };
    const label = normalizeText(record.label, CONVERSATION_TOPIC_LIMITS.labelLength, { multiline: false });
    if (!label.ok) return { ok: false, reason: "invalid_label", index };
    const labels: Record<string, string> = {};
    const given = record.labels && typeof record.labels === "object" && !Array.isArray(record.labels) ? Object.entries(record.labels as Record<string, unknown>) : [];
    if (given.length > CONVERSATION_TOPIC_LIMITS.languages) return { ok: false, reason: "invalid_label", index };
    for (const [locale, value] of given) {
      if (!/^[a-z]{2}$/.test(locale)) return { ok: false, reason: "invalid_label", index };
      if (typeof value === "string" && !value.trim()) continue;
      const translated = normalizeText(value, CONVERSATION_TOPIC_LIMITS.labelLength, { multiline: false });
      if (!translated.ok) return { ok: false, reason: "invalid_label", index };
      labels[locale] = translated.value;
    }
    seen.add(key);
    topics.push(Object.keys(labels).length ? { key, label: label.value, labels } : { key, label: label.value });
  }
  return { ok: true, value: topics };
}

/** Buyer projections show public lines only; staff notes never leave the dashboard. */
export function isBuyerVisibleMessage(message: { visibility: ConversationMessageVisibility }): boolean {
  return message.visibility === "public";
}
