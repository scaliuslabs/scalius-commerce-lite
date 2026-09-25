// OpenAPI schemas for conversation threads (Wave A §6). Buyer shapes never
// carry internal notes or staff identity (C4); staff shapes do.
import { z } from "@hono/zod-openapi";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";

export const conversationIdSchema = z.string().regex(/^cnv_[A-Za-z0-9_-]{8,64}$/);
export const conversationAttachmentIdSchema = z.string().regex(/^att_[A-Za-z0-9_-]{8,64}$/);
const conversationStatusSchema = z.enum(["open", "pending", "closed"]);
const subjectTypeSchema = z.enum(["order", "store", "warranty_claim", "review"]);
const authorTypeSchema = z.enum(["customer", "guest_receipt", "staff", "system"]);

export const conversationAttachmentSchema = z.object({
  id: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const eventDataSchema = z.record(z.string(), z.unknown()).nullable();

export const buyerConversationMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.enum(["message", "event"]),
  from: z.enum(["buyer", "store", "system"]),
  body: z.string().nullable(),
  eventKind: z.string().nullable(),
  eventData: eventDataSchema,
  createdAt: z.number().int(),
  attachments: z.array(conversationAttachmentSchema),
});

export const buyerConversationSummarySchema = z.object({
  id: z.string(),
  subjectType: subjectTypeSchema,
  subject: z.string().nullable(),
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  status: conversationStatusSchema,
  lastMessageAt: z.number().int().nullable(),
  unread: z.number().int(),
});

export const buyerConversationThreadSchema = buyerConversationSummarySchema.extend({
  lastSeq: z.number().int(),
  readSeq: z.number().int(),
  messages: z.array(buyerConversationMessageSchema),
  hasMore: z.boolean(),
});

export const staffConversationSummarySchema = z.object({
  id: z.string(),
  subjectType: subjectTypeSchema,
  subjectId: z.string().nullable(),
  subject: z.string().nullable(),
  status: conversationStatusSchema,
  orderId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  lastMessageAt: z.number().int().nullable(),
  lastAuthorType: authorTypeSchema.nullable(),
  preview: z.string().nullable(),
  unread: z.number().int(),
  version: z.number().int(),
});

export const staffConversationMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.enum(["message", "event"]),
  visibility: z.enum(["public", "internal"]),
  authorType: authorTypeSchema,
  authorUserId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string().nullable(),
  eventKind: z.string().nullable(),
  eventData: eventDataSchema,
  createdAt: z.number().int(),
  attachments: z.array(conversationAttachmentSchema),
});

export const staffConversationThreadSchema = staffConversationSummarySchema.extend({
  lastSeq: z.number().int(),
  staffReadSeq: z.number().int(),
  customerReadSeq: z.number().int(),
  messages: z.array(staffConversationMessageSchema),
  hasMore: z.boolean(),
  order: z.object({
    id: z.string(),
    orderNumber: z.string().nullable(),
    status: z.string(),
    paymentStatus: z.string(),
    totalAmountMinor: z.number().int(),
    currencyCode: z.string().nullable(),
    createdAt: z.number().int().nullable(),
  }).nullable(),
  cases: z.array(z.object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    label: z.string(),
    active: z.boolean(),
    returnId: z.string().nullable(),
  })),
});

export const clientMessageKeySchema = z.string().trim().min(1).max(CONVERSATION_LIMITS.clientMessageKeyLength);

/** A buyer post: text, an idempotency key and up to three staged images. No contact fields (§4.3). */
export const buyerPostBodySchema = z.object({
  body: z.string().max(CONVERSATION_LIMITS.bodyLength * 2),
  clientMessageKey: clientMessageKeySchema,
  attachmentIds: z.array(conversationAttachmentIdSchema).max(CONVERSATION_LIMITS.attachmentsPerMessage).optional(),
}).strict();

export const readBodySchema = z.object({ seq: z.number().int().nonnegative() }).strict();

export const beforeSeqQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
});

export const attachmentUploadResponseSchema = z.object({
  attachmentId: z.string(),
  conversationId: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

/** Multipart form: `file` plus the thread (`conversationId`) or the order whose thread to use (`orderId`). */
export const attachmentUploadRequest = {
  content: {
    "multipart/form-data": {
      schema: z.object({
        file: z.any().openapi({ type: "string", format: "binary" }),
        conversationId: z.string().optional(),
        orderId: z.string().optional(),
      }),
    },
  },
};
