// Conversation views shared by the API, the dashboard inbox and the storefront
// thread panel. Pure types: no database imports.

import type {
  ConversationAuthorType,
  ConversationMessageKind,
  ConversationMessageVisibility,
  ConversationStatus,
  ConversationSubjectType,
} from "@scalius/shared/conversation";

export interface ConversationAttachmentView {
  id: string;
  mediaType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/** One stored line: everything a staff view may show. */
export interface ConversationMessageRecord {
  id: string;
  seq: number;
  kind: ConversationMessageKind;
  visibility: ConversationMessageVisibility;
  authorType: ConversationAuthorType;
  authorUserId: string | null;
  authorName: string | null;
  body: string | null;
  eventKind: string | null;
  eventData: Record<string, unknown> | null;
  createdAt: number;
  attachments: ConversationAttachmentView[];
}

/** A line as a buyer sees it: public only, no staff identity beyond "the store". */
export interface BuyerConversationMessage {
  id: string;
  seq: number;
  kind: ConversationMessageKind;
  /** `buyer` for the buyer's own lines, `store` for staff replies, `system` for events. */
  from: "buyer" | "store" | "system";
  body: string | null;
  eventKind: string | null;
  eventData: Record<string, unknown> | null;
  createdAt: number;
  attachments: ConversationAttachmentView[];
}

export interface BuyerConversationSummary {
  id: string;
  subjectType: ConversationSubjectType;
  subject: string | null;
  orderId: string | null;
  orderNumber: string | null;
  status: ConversationStatus;
  lastMessageAt: number | null;
  unread: number;
}

export interface BuyerConversationThread extends BuyerConversationSummary {
  lastSeq: number;
  readSeq: number;
  messages: BuyerConversationMessage[];
  /** More (older) messages exist before the first one returned. */
  hasMore: boolean;
}

export interface StaffConversationSummary {
  id: string;
  subjectType: ConversationSubjectType;
  /** The review or warranty claim a Wave B thread is about; null for order and store threads. */
  subjectId: string | null;
  subject: string | null;
  status: ConversationStatus;
  orderId: string | null;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  lastMessageAt: number | null;
  lastAuthorType: ConversationAuthorType | null;
  /** The last line's text, trimmed for the list; null for events and attachment-only lines. */
  preview: string | null;
  unread: number;
  version: number;
}

export interface StaffConversationCase {
  id: string;
  type: string;
  status: string;
  label: string;
  active: boolean;
  returnId: string | null;
}

export interface StaffConversationThread extends StaffConversationSummary {
  lastSeq: number;
  staffReadSeq: number;
  customerReadSeq: number;
  messages: ConversationMessageRecord[];
  hasMore: boolean;
  /** Order context for the rail; null for store threads. */
  order: {
    id: string;
    orderNumber: string | null;
    status: string;
    paymentStatus: string;
    totalAmountMinor: number;
    currencyCode: string | null;
    createdAt: number | null;
  } | null;
  /** The order's support-request cases, newest first. */
  cases: StaffConversationCase[];
}

export interface StaffInboxSummary {
  open: number;
  mineOpen: number;
  unassignedOpen: number;
}

/** Who is posting or reading, as resolved by the route (never from the body). */
export type ConversationActor =
  | { kind: "customer"; customerId: string }
  | { kind: "guest_receipt"; orderId: string }
  | { kind: "staff"; userId: string };
