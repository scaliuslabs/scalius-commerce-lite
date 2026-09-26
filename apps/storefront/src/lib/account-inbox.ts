// Buyer conversations (Wave A §4, §8.2): the account Inbox and the order
// thread panel. Pure and browser-safe: the server pages render with these
// helpers and the same-origin proxies (`pages/api/conversations/**`) render
// the updated thread with them, so a no-JS post and an enhanced post show the
// same markup.
//
// Privacy: message text, phone, email and receipt proof never enter a URL.
// URLs carry only opaque ids (order, `cnv_`, `att_`), a message sequence
// number, a list cursor and one short status flag from STATUS_FLAGS.

import { escapeHtml } from "@scalius/shared/html-escape";
import {
  CONVERSATION_ATTACHMENT_UPLOAD_TYPES,
  CONVERSATION_LIMITS,
  isConversationAttachmentId,
  isConversationId,
} from "@scalius/shared/conversation";
import type {
  GetApiV1CustomerAuthConversationsByIdResponses,
  GetApiV1CustomerAuthConversationsResponses,
} from "@scalius/api-client/types";

type InboxPage = GetApiV1CustomerAuthConversationsResponses[200]["data"];
export type BuyerConversationSummary = InboxPage["items"][number];
export type BuyerConversationThread = GetApiV1CustomerAuthConversationsByIdResponses[200]["data"]["conversation"];
export type BuyerConversationMessage = BuyerConversationThread["messages"][number];
export type BuyerConversationAttachment = BuyerConversationMessage["attachments"][number];
export interface BuyerInboxPage {
  items: BuyerConversationSummary[];
  nextCursor: string | null;
  canStartStoreConversation: boolean;
}

/** How the buyer reaches an order thread: their account session, or the receipt cookie of a guest order. */
export type ConversationAccess = "account" | "receipt";

export { CONVERSATION_LIMITS, isConversationAttachmentId, isConversationId };

/** English, like the other account pages. One place so a later language pass can swap it. */
export const CONVERSATION_COPY = {
  inboxTitle: "Inbox",
  inboxEmpty: "No messages yet. Questions about an order start from the order page.",
  signInTitle: "Sign in to see your messages",
  signInBody: "Your conversations with the store appear here after you sign in.",
  signIn: "Sign in",
  unavailable: "We couldn't reach the store. Check your connection and try again.",
  retry: "Try again",
  notFound: "This conversation isn't available.",
  backToInbox: "Inbox",
  olderConversations: "Older conversations",
  earlierMessages: "Show earlier messages",
  latestMessages: "Show latest messages",
  newDivider: "New",
  you: "You",
  store: "Store",
  messageLabel: "Message",
  subjectLabel: "Subject",
  send: "Send",
  sending: "Sending…",
  attachLabel: "Add images (optional)",
  attachHint: "Up to 3 images: JPEG, PNG or WebP, 5 MB each.",
  startTitle: "Message the store",
  startIntro: "Ask about products, delivery or anything else. We'll reply here.",
  startSubmit: "Send message",
  startNeedsVerification: "To message the store, verify your phone number or email on your account page first.",
  startNeedsVerificationLink: "Go to your account",
  orderPanelTitle: "Questions about this order?",
  orderPanelIntro: "Message us and we'll reply here.",
  orderPanelOpenInbox: "Open in your inbox",
  orderPanelTruncated: "Showing the latest messages.",
  closedNote: "This conversation is closed. Sending a message reopens it.",
  imageFromStore: "Image from the store",
  imageFromYou: "Image you sent",
  viewOrder: "View order",
} as const;

// ---------------------------------------------------------------------------
// Post/Redirect/Get status flags
// ---------------------------------------------------------------------------

/** The query parameter that carries a post's outcome back to the page. */
export const CONVERSATION_STATUS_PARAM = "conversation";

export const STATUS_FLAGS = [
  "sent",
  "started",
  "invalid",
  "image",
  "rate",
  "limit",
  "unverified",
  "signin",
  "missing",
  "unavailable",
] as const;
export type ConversationStatusFlag = (typeof STATUS_FLAGS)[number];

const STATUS_MESSAGES: Record<ConversationStatusFlag, { tone: "success" | "error"; text: string }> = {
  sent: { tone: "success", text: "Message sent." },
  started: { tone: "success", text: "Message sent. We'll reply here." },
  invalid: { tone: "error", text: "Write a message of up to 5,000 characters, then send it again." },
  image: { tone: "error", text: "Those images couldn't be attached. Use up to 3 JPEG, PNG or WebP images of 5 MB or less." },
  rate: { tone: "error", text: "You're sending too quickly. Please wait a moment and try again." },
  limit: { tone: "error", text: "You already have 5 open conversations. Reply in one of them, or wait for the store to close one." },
  unverified: { tone: "error", text: CONVERSATION_COPY.startNeedsVerification },
  signin: { tone: "error", text: "Your session expired. Sign in again to send messages." },
  missing: { tone: "error", text: "This conversation isn't available from this browser." },
  unavailable: { tone: "error", text: CONVERSATION_COPY.unavailable },
};

export function isConversationStatusFlag(value: unknown): value is ConversationStatusFlag {
  return typeof value === "string" && (STATUS_FLAGS as readonly string[]).includes(value);
}

/** The flag in a page URL, or null for anything else. */
export function readConversationStatusFlag(url: URL): ConversationStatusFlag | null {
  const value = url.searchParams.get(CONVERSATION_STATUS_PARAM);
  return isConversationStatusFlag(value) ? value : null;
}

export function conversationStatusMessage(flag: ConversationStatusFlag): { tone: "success" | "error"; text: string } {
  return STATUS_MESSAGES[flag];
}

/** What a failed API answer means for the buyer. */
export function statusFlagForApiStatus(status: number, action: "post" | "start" | "upload" = "post"): ConversationStatusFlag {
  if (status >= 200 && status < 300) return action === "start" ? "started" : "sent";
  if (status === 400 || status === 413 || status === 422) return action === "upload" ? "image" : "invalid";
  if (status === 401) return "signin";
  if (status === 403) return action === "start" ? "unverified" : "missing";
  if (status === 404) return "missing";
  if (status === 409) return "limit";
  if (status === 429) return "rate";
  if (status === 503 && action === "upload") return "image";
  return "unavailable";
}

// Pages that host a conversation form. A post only ever redirects back to one.
const RETURN_PATH_PATTERN = /^\/(?:account\/inbox(?:\/[A-Za-z0-9_-]{1,128})?|account\/orders\/[A-Za-z0-9_-]{1,128}|account\/warranties|warranty-claims\/[A-Za-z0-9_-]{1,128}\/wcl_[A-Za-z0-9_-]{8,64}|order-success|track-order)\/?$/;

/**
 * A same-origin page to return to after a post, or null. Only the pages that
 * mount a conversation form qualify; protocol-relative, absolute and
 * backslash paths are refused. The old status flag is dropped.
 */
export function safeConversationReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 512) return null;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, "https://storefront.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://storefront.invalid") return null;
  if (!RETURN_PATH_PATTERN.test(url.pathname)) return null;
  url.searchParams.delete(CONVERSATION_STATUS_PARAM);
  return `${url.pathname}${url.search}`;
}

/** `returnTo` with the outcome flag and the thread anchor. */
export function withConversationStatus(returnTo: string, flag: ConversationStatusFlag, anchor = "conversation"): string {
  const url = new URL(returnTo, "https://storefront.invalid");
  url.searchParams.set(CONVERSATION_STATUS_PARAM, flag);
  url.hash = anchor;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The current page as a return path (the status flag removed). */
export function currentReturnPath(url: URL): string {
  const next = new URL(url.pathname + url.search, "https://storefront.invalid");
  next.searchParams.delete(CONVERSATION_STATUS_PARAM);
  return `${next.pathname}${next.search}`;
}

// ---------------------------------------------------------------------------
// Ids and form fields
// ---------------------------------------------------------------------------

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CLIENT_MESSAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_.:=-]{1,100}$/;

export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID_PATTERN.test(value);
}

export function isClientMessageKey(value: unknown): value is string {
  return typeof value === "string" && CLIENT_MESSAGE_KEY_PATTERN.test(value);
}

/** One key per form render, so a double submit posts once. */
export function newClientMessageKey(): string {
  return `cmk_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function readInboxCursor(value: string | null): string | undefined {
  return value && CURSOR_PATTERN.test(value) ? value : undefined;
}

export function readBeforeSeq(value: string | null): number | undefined {
  if (!value || !/^\d{1,9}$/.test(value)) return undefined;
  const seq = Number(value);
  return seq > 0 ? seq : undefined;
}

export type AttachmentCheck =
  | { ok: true; files: File[] }
  | { ok: false; reason: "too_many" | "too_large" | "wrong_type" };

const UPLOAD_TYPES = new Set<string>(CONVERSATION_ATTACHMENT_UPLOAD_TYPES);

/**
 * The chosen images, or why they can't be sent. An empty file part (no file
 * chosen in a no-JS form) is ignored. The API re-checks by content.
 */
export function checkAttachmentFiles(entries: Iterable<FormDataEntryValue>): AttachmentCheck {
  const files = [...entries].filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
  if (files.length > CONVERSATION_LIMITS.attachmentsPerMessage) return { ok: false, reason: "too_many" };
  for (const file of files) {
    if (file.size > CONVERSATION_LIMITS.attachmentBytes) return { ok: false, reason: "too_large" };
    if (file.type && !UPLOAD_TYPES.has(file.type)) return { ok: false, reason: "wrong_type" };
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Dhaka",
});

/** "24 Sep 2026, 5:46 PM" in Bangladesh time, like the order pages. */
export function formatConversationTime(unixSeconds: number | null | undefined): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  const part = Object.fromEntries(DATE_PARTS.formatToParts(new Date(unixSeconds * 1000)).map(({ type, value }) => [type, value]));
  return `${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute} ${part.dayPeriod}`;
}

function isoTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function conversationTitle(summary: Pick<BuyerConversationSummary, "subjectType" | "subject" | "orderNumber">): string {
  if (summary.subjectType === "order") {
    return summary.orderNumber ? `Order ${summary.orderNumber}` : "Your order";
  }
  return summary.subject?.trim() || "Message to the store";
}

const STATUS_LABELS: Record<BuyerConversationSummary["status"], string> = {
  open: "Waiting for the store",
  pending: "Store replied",
  closed: "Closed",
};

export function conversationStatusLabel(status: BuyerConversationSummary["status"]): string {
  return STATUS_LABELS[status] ?? status;
}

const REQUEST_TYPE_LABELS: Record<string, string> = {
  cancel_pre_shipment: "Cancellation request",
  return: "Return request",
  refund: "Refund request",
};

const REQUEST_STATUS_LABELS: Record<string, string> = {
  submitted: "submitted",
  under_review: "under review",
  approved: "approved",
  rejected: "declined",
  withdrawn: "withdrawn",
  completed: "completed",
};

function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A system line: "Cancellation request submitted", "Return request status: approved". */
export function conversationEventLine(message: Pick<BuyerConversationMessage, "eventKind" | "eventData" | "body">): string {
  const data = message.eventData ?? {};
  const type = REQUEST_TYPE_LABELS[eventText(data.type)] ?? "Request";
  if (message.eventKind === "support_request_submitted") return `${type} submitted`;
  if (message.eventKind === "support_request_status") {
    const status = eventText(data.toStatus) || eventText(data.status);
    const label = REQUEST_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
    return label ? `${type} status: ${label}` : `${type} updated`;
  }
  return message.body?.trim() || "Conversation updated";
}

/** Same-origin image URL for an attachment. Opaque ids only; the proxy adds the session or receipt proof. */
export function conversationAttachmentUrl(
  target:
    | { access: "account"; conversationId: string }
    | { access: "receipt"; orderId: string }
    | { access: "claim"; orderId: string; claimId: string },
  attachmentId: string,
): string {
  const attachment = encodeURIComponent(attachmentId);
  if (target.access === "claim") {
    return `/api/warranties/orders/${encodeURIComponent(target.orderId)}/claims/${encodeURIComponent(target.claimId)}/attachments/${attachment}`;
  }
  return target.access === "account"
    ? `/api/conversations/${encodeURIComponent(target.conversationId)}/attachments/${attachment}`
    : `/api/conversations/orders/${encodeURIComponent(target.orderId)}/attachments/${attachment}`;
}

export interface RenderMessagesOptions {
  /** Image URL for an attachment of this thread. */
  attachmentUrl: (attachmentId: string) => string;
  /** The buyer's read marker before this view; a "New" divider precedes the first later store line. */
  readSeq?: number;
}

function renderAttachments(message: BuyerConversationMessage, options: RenderMessagesOptions, mine: boolean): string {
  const images = message.attachments.filter((attachment) => isConversationAttachmentId(attachment.id));
  if (images.length === 0) return "";
  const alt = mine ? CONVERSATION_COPY.imageFromYou : CONVERSATION_COPY.imageFromStore;
  return `<div class="mt-2 flex flex-wrap gap-2">${images.map((attachment) => {
    const url = escapeHtml(options.attachmentUrl(attachment.id));
    const size = attachment.width && attachment.height
      ? ` width="${attachment.width}" height="${attachment.height}"`
      : "";
    return `<a href="${url}" target="_blank" rel="noopener" class="block overflow-hidden rounded-lg border border-border bg-background"><img src="${url}" alt="${escapeHtml(alt)}"${size} loading="lazy" decoding="async" class="h-28 w-28 object-cover" /></a>`;
  }).join("")}</div>`;
}

/** The thread as list items: the buyer's lines on the right, the store's on the left, events centered. */
export function renderConversationMessages(
  messages: readonly BuyerConversationMessage[],
  options: RenderMessagesOptions,
): string {
  let dividerShown = false;
  return messages.map((message) => {
    const time = formatConversationTime(message.createdAt);
    const timeTag = time ? `<time datetime="${escapeHtml(isoTime(message.createdAt))}">${escapeHtml(time)}</time>` : "";
    const divider = !dividerShown
      && typeof options.readSeq === "number"
      && message.seq > options.readSeq
      && message.from !== "buyer"
      ? (dividerShown = true, `<li class="flex items-center gap-3 text-xs font-medium text-primary" role="separator"><span class="h-px flex-1 bg-primary/30"></span>${escapeHtml(CONVERSATION_COPY.newDivider)}<span class="h-px flex-1 bg-primary/30"></span></li>`)
      : "";

    if (message.kind === "event" || message.from === "system") {
      return `${divider}<li class="px-2 text-center text-xs text-muted-foreground" data-seq="${message.seq}"><p>${escapeHtml(conversationEventLine(message))}</p>${timeTag ? `<p class="mt-0.5">${timeTag}</p>` : ""}</li>`;
    }

    const mine = message.from === "buyer";
    const author = mine ? CONVERSATION_COPY.you : CONVERSATION_COPY.store;
    const bubble = mine
      ? "rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground"
      : "rounded-2xl rounded-bl-md border border-border bg-muted px-4 py-2.5 text-foreground";
    const body = message.body ? `<p class="whitespace-pre-line break-words text-sm">${escapeHtml(message.body)}</p>` : "";
    return `${divider}<li class="flex ${mine ? "justify-end" : "justify-start"}" data-seq="${message.seq}">
  <div class="max-w-[85%] sm:max-w-[75%]">
    <div class="${bubble}"><span class="sr-only">${escapeHtml(author)}: </span>${body}${renderAttachments(message, options, mine)}</div>
    <p class="mt-1 text-xs text-muted-foreground ${mine ? "text-right" : "text-left"}">${escapeHtml(author)}${timeTag ? ` · ${timeTag}` : ""}</p>
  </div>
</li>`;
  }).join("");
}

/** The Inbox list: one row per conversation with an unread dot. */
export function renderInboxItems(items: readonly BuyerConversationSummary[]): string {
  return items.filter((item) => isConversationId(item.id)).map((item) => {
    const href = `/account/inbox/${encodeURIComponent(item.id)}`;
    const unread = item.unread > 0;
    const time = formatConversationTime(item.lastMessageAt);
    return `<li>
  <a href="${escapeHtml(href)}" data-astro-prefetch="false" class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span aria-hidden="true" class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}"></span>
    <span class="min-w-0 flex-1">
      <span class="block break-words text-sm ${unread ? "font-semibold" : "font-medium"} text-foreground">${escapeHtml(conversationTitle(item))}</span>
      <span class="mt-0.5 block text-sm text-muted-foreground">${escapeHtml(conversationStatusLabel(item.status))}${unread ? ` · <span class="font-medium text-primary">${escapeHtml(unreadLabel(item.unread))}</span>` : ""}</span>
    </span>
    ${time ? `<span class="shrink-0 text-xs text-muted-foreground">${escapeHtml(time)}</span>` : ""}
  </a>
</li>`;
  }).join("");
}

export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  const shown = count > 99 ? "99+" : String(count);
  return `${shown} new`;
}

/** Badge text for the Inbox link: "", "3", "99+". */
export function inboxBadgeText(unread: number): string {
  if (!Number.isFinite(unread) || unread <= 0) return "";
  return unread > 99 ? "99+" : String(Math.floor(unread));
}
