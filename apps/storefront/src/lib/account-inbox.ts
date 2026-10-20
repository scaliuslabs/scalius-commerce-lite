// Buyer conversations (Wave A §4, §8.2): the account Inbox and the order
// thread panel. Pure and browser-safe: the server pages render with these
// helpers and the same-origin proxies (`pages/api/conversations/**`) render
// the updated thread with them, so a no-JS post and an enhanced post show the
// same markup.
//
// Privacy: message text, phone, email and receipt proof never enter a URL.
// URLs carry only opaque ids (order, `cnv_`, `att_`), a message sequence
// number, a list cursor and one short status flag from STATUS_FLAGS.

import { formatCount, formatStoreDateTime, pageLanguage, storeTimeZone } from "./store-time-zone";
import { storefrontLanguage } from "./storefront-copy";
import { escapeHtml } from "@scalius/shared/html-escape";
import { groupConversationMessages } from "@scalius/shared/conversation-grouping";
import { formatMoney } from "@/lib/currency";
import {
  CONVERSATION_ATTACHMENT_UPLOAD_TYPES,
  CONVERSATION_LIMITS,
  isConversationAttachmentId,
  isConversationId,
  type ConversationProductCard,
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

/** The conversations' words in English and Bangla; `conversationCopy()` picks the page's language. */
const CONVERSATION_COPY_EN = {
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
  imageUnavailable: "Image unavailable",
  noLongerAvailable: "No longer available",
  soldOut: "Sold out",
  viewProduct: "View product",
  showMore: "Show more",
  showLess: "Show less",
  orderTitle: "Order {number}",
  yourOrder: "Your order",
  messageToStore: "Message to the store",
  statusOpen: "Waiting for the store",
  statusPending: "Store replied",
  statusClosed: "Closed",
  requestCancel: "Cancellation request",
  requestReturn: "Return request",
  requestRefund: "Refund request",
  request: "Request",
  requestSubmitted: "{type} submitted",
  requestStatus: "{type} status: {status}",
  requestUpdated: "{type} updated",
  requestStates: {
    submitted: "submitted", under_review: "under review", approved: "approved", rejected: "declined",
    withdrawn: "withdrawn", completed: "completed",
  } as Record<string, string>,
  conversationUpdated: "Conversation updated",
  unreadNew: "{count} new",
  notInInbox: "This conversation isn't in your inbox.",
  noMessages: "No messages yet",
  conversationsLabel: "Conversations",
  messagesLabel: "Messages",
  historyLabel: "Conversation history",
  reply: "Reply",
  writeReply: "Write a reply",
  writeMessage: "Write your message",
  markRead: "Mark messages as read",
  newMessages: "New messages",
  reloadConversation: "Reload conversation",
  newFromStore: "{count} from the store",
  newMessageCount: { one: "{count} new message", other: "{count} new messages" },
  accountChangedSend: "Your account changed. Reload before sending a message.",
  accountChangedRead: "Your account changed. Reload to see your messages.",
  changedReload: "This conversation changed. Reload to continue.",
  signInToReceive: "Sign in again to receive messages.",
  noLongerHere: "This conversation is no longer available here.",
  moreAvailable: "More messages are available. Reload to see the latest.",
  earlierLoaded: "Earlier messages loaded.",
  earlierFailed: "Couldn't load earlier messages. Try again.",
  statusSent: "Message sent.",
  statusStarted: "Message sent. We'll reply here.",
  statusInvalid: "Write a message of up to 5,000 characters, then send it again.",
  statusImage: "Those images couldn't be attached. Use up to 3 JPEG, PNG or WebP images of 5 MB or less.",
  statusRate: "You're sending too quickly. Please wait a moment and try again.",
  statusLimit: "You already have 5 open conversations. Reply in one of them, or wait for the store to close one.",
  statusSignin: "Your session expired. Sign in again to send messages.",
  statusMissing: "This conversation isn't available from this browser.",
};

export type ConversationCopy = typeof CONVERSATION_COPY_EN;

const CONVERSATION_COPY_BN: ConversationCopy = {
  inboxTitle: "ইনবক্স",
  inboxEmpty: "এখনো কোনো মেসেজ নেই। কোনো অর্ডার নিয়ে প্রশ্ন থাকলে অর্ডারের পেজ থেকে লিখুন।",
  signInTitle: "আপনার মেসেজ দেখতে সাইন ইন করুন",
  signInBody: "সাইন ইন করলে স্টোরের সাথে আপনার কথোপকথন এখানে দেখা যাবে।",
  signIn: "সাইন ইন",
  unavailable: "স্টোরের সাথে যোগাযোগ করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
  retry: "আবার চেষ্টা করুন",
  notFound: "এই কথোপকথনটি পাওয়া যাচ্ছে না।",
  backToInbox: "ইনবক্স",
  olderConversations: "পুরোনো কথোপকথন",
  earlierMessages: "আগের মেসেজ দেখুন",
  latestMessages: "সাম্প্রতিক মেসেজ দেখুন",
  newDivider: "নতুন",
  you: "আপনি",
  store: "স্টোর",
  messageLabel: "মেসেজ",
  subjectLabel: "বিষয়",
  send: "পাঠান",
  sending: "পাঠানো হচ্ছে…",
  attachLabel: "ছবি যোগ করুন (ঐচ্ছিক)",
  attachHint: "সর্বোচ্চ ৩টি ছবি: জেপিইজি, পিএনজি বা ওয়েবপি, প্রতিটি ৫ মেগাবাইট পর্যন্ত।",
  startTitle: "স্টোরকে মেসেজ পাঠান",
  startIntro: "পণ্য, ডেলিভারি বা যেকোনো বিষয়ে জিজ্ঞেস করুন। আমরা এখানেই উত্তর দেব।",
  startSubmit: "মেসেজ পাঠান",
  startNeedsVerification: "স্টোরকে মেসেজ পাঠাতে আগে আপনার অ্যাকাউন্ট পেজে ফোন নম্বর বা ইমেইল যাচাই করুন।",
  startNeedsVerificationLink: "আপনার অ্যাকাউন্টে যান",
  orderPanelTitle: "এই অর্ডার নিয়ে প্রশ্ন আছে?",
  orderPanelIntro: "আমাদের মেসেজ পাঠান, আমরা এখানেই উত্তর দেব।",
  orderPanelOpenInbox: "ইনবক্সে খুলুন",
  orderPanelTruncated: "সাম্প্রতিক মেসেজগুলো দেখানো হচ্ছে।",
  closedNote: "এই কথোপকথনটি বন্ধ। মেসেজ পাঠালে এটি আবার খুলবে।",
  imageFromStore: "স্টোরের পাঠানো ছবি",
  imageFromYou: "আপনার পাঠানো ছবি",
  viewOrder: "অর্ডার দেখুন",
  imageUnavailable: "ছবিটি পাওয়া যাচ্ছে না",
  noLongerAvailable: "আর পাওয়া যাচ্ছে না",
  soldOut: "স্টক শেষ",
  viewProduct: "পণ্যটি দেখুন",
  showMore: "আরও দেখুন",
  showLess: "কম দেখান",
  orderTitle: "অর্ডার {number}",
  yourOrder: "আপনার অর্ডার",
  messageToStore: "স্টোরকে মেসেজ",
  statusOpen: "স্টোরের উত্তরের অপেক্ষায়",
  statusPending: "স্টোর উত্তর দিয়েছে",
  statusClosed: "বন্ধ",
  requestCancel: "বাতিলের অনুরোধ",
  requestReturn: "ফেরতের অনুরোধ",
  requestRefund: "রিফান্ডের অনুরোধ",
  request: "অনুরোধ",
  requestSubmitted: "{type} পাঠানো হয়েছে",
  requestStatus: "{type}-এর অবস্থা: {status}",
  requestUpdated: "{type} আপডেট হয়েছে",
  requestStates: {
    submitted: "পাঠানো হয়েছে", under_review: "যাচাই চলছে", approved: "অনুমোদিত", rejected: "নাকচ হয়েছে",
    withdrawn: "তুলে নেওয়া হয়েছে", completed: "সম্পন্ন",
  },
  conversationUpdated: "কথোপকথন আপডেট হয়েছে",
  unreadNew: "{count}টি নতুন",
  notInInbox: "এই কথোপকথনটি আপনার ইনবক্সে নেই।",
  noMessages: "এখনো কোনো মেসেজ নেই",
  conversationsLabel: "কথোপকথন",
  messagesLabel: "মেসেজ",
  historyLabel: "কথোপকথনের ইতিহাস",
  reply: "উত্তর",
  writeReply: "উত্তর লিখুন",
  writeMessage: "আপনার মেসেজ লিখুন",
  markRead: "মেসেজগুলো পড়া হয়েছে চিহ্নিত করুন",
  newMessages: "নতুন মেসেজ",
  reloadConversation: "কথোপকথন আবার লোড করুন",
  newFromStore: "স্টোর থেকে {count}",
  newMessageCount: { one: "{count}টি নতুন মেসেজ", other: "{count}টি নতুন মেসেজ" },
  accountChangedSend: "আপনার অ্যাকাউন্ট বদলেছে। মেসেজ পাঠানোর আগে পেজটি আবার লোড করুন।",
  accountChangedRead: "আপনার অ্যাকাউন্ট বদলেছে। মেসেজ দেখতে পেজটি আবার লোড করুন।",
  changedReload: "এই কথোপকথনটি বদলেছে। চালিয়ে যেতে পেজটি আবার লোড করুন।",
  signInToReceive: "মেসেজ পেতে আবার সাইন ইন করুন।",
  noLongerHere: "এই কথোপকথনটি এখানে আর পাওয়া যাচ্ছে না।",
  moreAvailable: "আরও মেসেজ আছে। সাম্প্রতিকগুলো দেখতে পেজটি আবার লোড করুন।",
  earlierLoaded: "আগের মেসেজগুলো লোড হয়েছে।",
  earlierFailed: "আগের মেসেজগুলো লোড করা যায়নি। আবার চেষ্টা করুন।",
  statusSent: "মেসেজ পাঠানো হয়েছে।",
  statusStarted: "মেসেজ পাঠানো হয়েছে। আমরা এখানেই উত্তর দেব।",
  statusInvalid: "সর্বোচ্চ ৫,০০০ অক্ষরের মেসেজ লিখে আবার পাঠান।",
  statusImage: "ছবিগুলো যোগ করা যায়নি। সর্বোচ্চ ৩টি জেপিইজি, পিএনজি বা ওয়েবপি ছবি দিন, প্রতিটি ৫ মেগাবাইট বা তার কম।",
  statusRate: "আপনি খুব দ্রুত পাঠাচ্ছেন। একটু অপেক্ষা করে আবার চেষ্টা করুন।",
  statusLimit: "আপনার ইতিমধ্যে ৫টি খোলা কথোপকথন আছে। সেগুলোর একটিতে উত্তর দিন, অথবা স্টোর একটি বন্ধ করা পর্যন্ত অপেক্ষা করুন।",
  statusSignin: "আপনার সেশনের মেয়াদ শেষ। মেসেজ পাঠাতে আবার সাইন ইন করুন।",
  statusMissing: "এই ব্রাউজার থেকে কথোপকথনটি পাওয়া যাচ্ছে না।",
};

/** The conversations' words in the page's language (Bangla on a Bangla page). */
export function conversationCopy(language: string = pageLanguage()): ConversationCopy {
  return storefrontLanguage(language) === "bn" ? CONVERSATION_COPY_BN : CONVERSATION_COPY_EN;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

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

export function isConversationStatusFlag(value: unknown): value is ConversationStatusFlag {
  return typeof value === "string" && (STATUS_FLAGS as readonly string[]).includes(value);
}

/** The flag in a page URL, or null for anything else. */
export function readConversationStatusFlag(url: URL): ConversationStatusFlag | null {
  const value = url.searchParams.get(CONVERSATION_STATUS_PARAM);
  return isConversationStatusFlag(value) ? value : null;
}

export function conversationStatusMessage(flag: ConversationStatusFlag): { tone: "success" | "error"; text: string } {
  const copy = conversationCopy();
  const text: Record<ConversationStatusFlag, string> = {
    sent: copy.statusSent,
    started: copy.statusStarted,
    invalid: copy.statusInvalid,
    image: copy.statusImage,
    rate: copy.statusRate,
    limit: copy.statusLimit,
    unverified: copy.startNeedsVerification,
    signin: copy.statusSignin,
    missing: copy.statusMissing,
    unavailable: copy.unavailable,
  };
  return { tone: flag === "sent" || flag === "started" ? "success" : "error", text: text[flag] };
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

/** "Sep 24, 2026, 5:46 PM" in the store's time zone, like the order pages. */
export function formatConversationTime(unixSeconds: number | null | undefined, timeZone: string = storeTimeZone()): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  return formatStoreDateTime(unixSeconds * 1000, pageLanguage(), { dateStyle: "medium", timeStyle: "short" }, timeZone);
}

function isoTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function conversationTitle(summary: Pick<BuyerConversationSummary, "subjectType" | "subject" | "orderNumber">): string {
  const copy = conversationCopy();
  if (summary.subjectType === "order") {
    return summary.orderNumber ? fill(copy.orderTitle, { number: String(summary.orderNumber) }) : copy.yourOrder;
  }
  return summary.subject?.trim() || copy.messageToStore;
}

export function conversationStatusLabel(status: BuyerConversationSummary["status"]): string {
  const copy = conversationCopy();
  return ({ open: copy.statusOpen, pending: copy.statusPending, closed: copy.statusClosed } as Record<string, string>)[status] ?? status;
}

function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A system line: "Cancellation request submitted", "Return request status: approved". */
export function conversationEventLine(message: Pick<BuyerConversationMessage, "eventKind" | "eventData" | "body">): string {
  const data = message.eventData ?? {};
  const copy = conversationCopy();
  const types: Record<string, string> = { cancel_pre_shipment: copy.requestCancel, return: copy.requestReturn, refund: copy.requestRefund };
  const type = types[eventText(data.type)] ?? copy.request;
  if (message.eventKind === "support_request_submitted") return fill(copy.requestSubmitted, { type });
  if (message.eventKind === "support_request_status") {
    const status = eventText(data.toStatus) || eventText(data.status);
    const label = copy.requestStates[status] ?? status.replace(/_/g, " ");
    return label ? fill(copy.requestStatus, { type, status: label }) : fill(copy.requestUpdated, { type });
  }
  return message.body?.trim() || copy.conversationUpdated;
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
  const copy = conversationCopy();
  const alt = mine ? copy.imageFromYou : copy.imageFromStore;
  return `<div class="mt-2 flex flex-wrap gap-2">${images.map((attachment) => {
    const url = escapeHtml(options.attachmentUrl(attachment.id));
    const size = attachment.width && attachment.height
      ? ` width="${attachment.width}" height="${attachment.height}"`
      : "";
    return `<a href="${url}" target="_blank" rel="noopener" class="block min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-background"><img data-message-image src="${url}" alt="${escapeHtml(alt)}"${size} loading="lazy" decoding="async" class="${images.length === 1 ? "max-h-60 max-w-full object-contain" : "h-24 w-24 object-cover"}" /><span hidden data-message-image-error class="flex h-24 w-24 items-center justify-center p-2 text-center text-sm text-muted-foreground">${escapeHtml(copy.imageUnavailable)}</span></a>`;
  }).join("")}</div>`;
}

function renderProducts(products: readonly ConversationProductCard[]): string {
  const copy = conversationCopy();
  return products.slice(0, 3).map((product) => {
    const href = product.pdpUrl?.startsWith("/") && !product.pdpUrl.startsWith("//") && !product.pdpUrl.includes("\\") ? product.pdpUrl : null;
    const image = product.imageUrl && /^https?:\/\//.test(product.imageUrl) ? product.imageUrl : null;
    const price = product.price ? formatMoney(product.price.amount, { code: product.price.currency }) : "";
    const availability = product.status === "unavailable" ? copy.noLongerAvailable : product.status === "sold_out" ? copy.soldOut : "";
    return `<div class="mt-2 flex gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground">
      ${image ? `<img src="${escapeHtml(image)}" alt="" width="48" height="48" loading="lazy" class="h-12 w-12 shrink-0 rounded-md object-cover" />` : ""}
      <div class="min-w-0 flex-1"><p class="break-words text-sm font-medium">${escapeHtml(product.title)}</p>${product.variantLabel ? `<p class="text-xs text-muted-foreground">${escapeHtml(product.variantLabel)}</p>` : ""}${price ? `<p class="mt-1 text-sm">${escapeHtml(price)}</p>` : ""}${availability ? `<p class="text-xs text-muted-foreground">${escapeHtml(availability)}</p>` : ""}${href ? `<a href="${escapeHtml(href)}" class="inline-flex min-h-11 items-center text-sm font-medium text-primary underline">${escapeHtml(copy.viewProduct)}</a>` : ""}</div>
    </div>`;
  }).join("");
}

/** The thread as list items: the buyer's lines on the right, the store's on the left, events centered. */
export function renderConversationMessages(
  messages: readonly BuyerConversationMessage[],
  options: RenderMessagesOptions,
): string {
  let dividerShown = false;
  const copy = conversationCopy();
  const language = pageLanguage();
  return groupConversationMessages(messages.map((message) => ({ ...message, kind: message.eventKind === "product_reply" ? "message" as const : message.kind, authorType: message.from, visibility: "public" })), {
    dayKey: (time) => formatStoreDateTime(time * 1000, language, { dateStyle: "medium" }),
  }).map(({ message, groupStart, showAuthor, startsDay }) => {
    const time = formatConversationTime(message.createdAt);
    const clock = formatStoreDateTime(message.createdAt * 1000, language, { timeStyle: "short" });
    const day = formatStoreDateTime(message.createdAt * 1000, language, { dateStyle: "medium" });
    const timeTag = time ? `<time datetime="${escapeHtml(isoTime(message.createdAt))}" title="${escapeHtml(time)}">${escapeHtml(clock)}</time>` : "";
    const dayLine = `<div data-message-day${startsDay ? "" : " hidden"} class="my-4 text-center text-xs text-muted-foreground">${escapeHtml(day)}</div>`;
    const meta = `data-seq="${message.seq}" data-message-id="${escapeHtml(message.id)}" data-from="${message.from}" data-created="${message.createdAt}" data-day="${escapeHtml(day)}" data-kind="${message.kind}"`;
    const divider = !dividerShown
      && typeof options.readSeq === "number"
      && message.seq > options.readSeq
      && message.from !== "buyer"
      ? (dividerShown = true, `<li class="flex items-center gap-3 text-xs font-medium text-primary" role="separator"><span class="h-px flex-1 bg-primary/30"></span>${escapeHtml(copy.newDivider)}<span class="h-px flex-1 bg-primary/30"></span></li>`)
      : "";

    const products = (message as BuyerConversationMessage & { products?: ConversationProductCard[] }).products ?? [];
    if ((message.kind === "event" && products.length === 0) || message.from === "system") {
      return `${divider}<li class="px-2 text-center text-xs text-muted-foreground" ${meta}>${dayLine}<p>${escapeHtml(conversationEventLine(message))}</p>${timeTag ? `<p class="mt-0.5">${timeTag}</p>` : ""}</li>`;
    }

    const mine = message.from === "buyer";
    const author = mine ? copy.you : copy.store;
    const bubble = mine
      ? "rounded-2xl rounded-ee-md bg-primary px-4 py-2.5 text-primary-foreground"
      : "rounded-2xl rounded-es-md border border-border bg-muted px-4 py-2.5 text-foreground";
    const body = message.body ? `<p data-message-body class="whitespace-pre-line break-words [overflow-wrap:anywhere] text-base leading-relaxed sm:text-sm">${escapeHtml(message.body)}</p><button type="button" hidden data-message-expand data-show-more="${escapeHtml(copy.showMore)}" data-show-less="${escapeHtml(copy.showLess)}" class="mt-1 min-h-11 text-sm underline">${escapeHtml(copy.showMore)}</button>` : "";
    return `${divider}<li class="${groupStart ? "mt-4" : "mt-1"} ${mine ? "justify-end" : "justify-start"}" ${meta}>
  ${dayLine}
  <div class="flex ${mine ? "justify-end" : "justify-start"}"><div class="min-w-0 max-w-[min(36rem,90%)]">
    <p data-message-author${showAuthor ? "" : " hidden"} class="mb-1 text-xs text-muted-foreground ${mine ? "text-end" : "text-start"}">${escapeHtml(author)}${timeTag ? ` · ${timeTag}` : ""}</p>
    <div class="${bubble}"><span class="sr-only">${escapeHtml(author)}: </span>${body}${renderAttachments(message, options, mine)}${renderProducts(products)}</div>
  </div></div>
</li>`;
  }).join("");
}

/** Independent rows for incremental reads and sends; dividers stay with the initial page. */
export function renderConversationItems(messages: readonly BuyerConversationMessage[], options: RenderMessagesOptions) {
  return messages.map((message) => ({
    id: message.id,
    seq: message.seq,
    html: renderConversationMessages([message], { attachmentUrl: options.attachmentUrl }),
  }));
}

/** The Inbox list: one row per conversation with an unread dot. */
export function renderInboxItems(items: readonly BuyerConversationSummary[]): string {
  return items.filter((item) => isConversationId(item.id)).map((item) => {
    const href = `/account/inbox/${encodeURIComponent(item.id)}`;
    const unread = item.unread > 0;
    const time = formatConversationTime(item.lastMessageAt);
    const language = pageLanguage();
    const day = (value: number) => formatStoreDateTime(value, language, { dateStyle: "short" });
    const compactTime = item.lastMessageAt ? formatStoreDateTime(item.lastMessageAt * 1000, language, day(item.lastMessageAt * 1000) === day(Date.now()) ? { timeStyle: "short" } : { month: "short", day: "numeric" }) : "";
    return `<li>
  <a href="${escapeHtml(href)}" data-astro-prefetch="false" class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span aria-hidden="true" class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}"></span>
    <span class="min-w-0 flex-1">
      <span class="block break-words text-sm ${unread ? "font-semibold" : "font-medium"} text-foreground">${escapeHtml(conversationTitle(item))}</span>
      <span class="mt-0.5 block text-sm text-muted-foreground">${escapeHtml(conversationStatusLabel(item.status))}${unread ? ` · <span class="font-medium text-primary">${escapeHtml(unreadLabel(item.unread))}</span>` : ""}</span>
    </span>
    ${time ? `<time datetime="${escapeHtml(isoTime(item.lastMessageAt!))}" title="${escapeHtml(time)}" class="shrink-0 text-xs text-muted-foreground">${escapeHtml(compactTime)}</time>` : ""}
  </a>
</li>`;
  }).join("");
}

export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  const shown = count > 99 ? `${formatCount(99)}+` : formatCount(count);
  return fill(conversationCopy().unreadNew, { count: shown });
}

/** Badge text for the Inbox link: "", "3", "99+" (in the page's digits). */
export function inboxBadgeText(unread: number): string {
  if (!Number.isFinite(unread) || unread <= 0) return "";
  return unread > 99 ? `${formatCount(99)}+` : formatCount(Math.floor(unread));
}
