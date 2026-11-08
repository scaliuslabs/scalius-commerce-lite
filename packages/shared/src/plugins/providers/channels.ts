// The messaging and push ports (packages/plugin-sdk/docs/apps.md, "Providers").
//
// Messaging: chat channels (WhatsApp, Messenger, Instagram, Telegram,
// Viber). A provider declares the channels it carries (`channels`). Core
// sends a store's buyer messages on a channel through the provider the
// merchant chose for it; the built-in WhatsApp sender (Meta Cloud API) is
// the default for WhatsApp.
//
// Inbound (the inbox): a provider that declares `verifyWebhook` receives the
// channel's pushes at `/api/v1/webhooks/messaging/{provider}` (GET and POST:
// a channel's subscription check is a GET). It authenticates the push and
// answers what it carries: buyer messages (each by the channel's own message
// id, so a redelivery is applied once) and delivery receipts for messages the
// store sent. Core files each message in the contact's thread (one per
// channel and contact) and staff replies go out through `send`.
//
// Push: notifications to a person's devices. Web Push (VAPID) is built in
// and needs no provider; an app push provider (a push service with its own
// subscriber list) receives the recipients by Scalius id and maps them to
// its own subscribers.
//
// A send answers `success: false` (with `retryable: false` when the same
// message can never pass), or throws a `ProviderError`, as the SMS port does.

import { z } from "zod";
import {
  providerHttpRequestSchema,
  providerIdempotencyKeySchema,
  providerReasonSchema,
  providerRefSchema,
} from "./common";
import { courierWebhookReplySchema } from "./courier";
import { messageStatusInputSchema, messageStatusSchema } from "./messaging";

/** The chat channels a messaging provider may carry. */
export const MESSAGING_CHANNELS = ["whatsapp", "messenger", "instagram", "telegram", "viber"] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

const rawStatus = z.string().max(300);

/** A pre-approved template (WhatsApp business messages outside the 24-hour window). */
export const messagingTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  /** `en_US`, `bn`. */
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
  /** The body values in order. */
  parameters: z.array(z.string().max(1024)).max(10).default([]),
}).strict();

export const messagingSendInputSchema = z.object({
  channel: z.enum(MESSAGING_CHANNELS),
  /** E.164 (`+8801XXXXXXXXX`) for WhatsApp and Viber; the channel's own recipient id otherwise. */
  to: z.string().min(1).max(128),
  /** Free text (inside the channel's reply window). Send `text` or `template`. */
  text: z.string().min(1).max(4096).optional(),
  template: messagingTemplateSchema.optional(),
  /** Deterministic per message: never send twice for one key. */
  idempotencyKey: providerIdempotencyKeySchema.optional(),
}).strict().refine((input) => (input.text === undefined) !== (input.template === undefined), "Send text or a template, not both.");
export type MessagingSendInput = z.infer<typeof messagingSendInputSchema>;

export const messagingSendSchema = z.object({
  success: z.boolean(),
  providerRef: providerRefSchema.optional(),
  rawStatus: rawStatus.optional(),
  /** False for errors a retry can never fix (bad credentials, no such recipient, rejected template). */
  retryable: z.boolean().optional(),
}).strict();
export type MessagingSend = z.infer<typeof messagingSendSchema>;

// ── Inbound ─────────────────────────────────────────────────────────────────

/** The kinds of media a buyer may send on a channel; the platform keeps a reference, never the bytes. */
export const MESSAGING_ATTACHMENT_KINDS = ["image", "video", "audio", "file", "sticker", "location"] as const;
export type MessagingAttachmentKind = (typeof MESSAGING_ATTACHMENT_KINDS)[number];

/** One attachment of an inbound message, as a reference the provider can resolve. */
export const messagingAttachmentSchema = z.object({
  kind: z.enum(MESSAGING_ATTACHMENT_KINDS),
  /** The provider's media id (fetch it through the provider). */
  ref: providerRefSchema.optional(),
  /** An https address of the media, when the channel gives one. */
  url: z.string().max(2000).regex(/^https:\/\/[^\s]+$/, "Use an https URL.").optional(),
  mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]{1,100}$/).optional(),
  name: z.string().min(1).max(200).optional(),
  sizeBytes: z.number().int().min(0).max(1024 * 1024 * 1024).optional(),
  /** A caption the buyer wrote with it. */
  caption: z.string().min(1).max(1024).optional(),
}).strict().refine((attachment) => attachment.ref !== undefined || attachment.url !== undefined, "Give the media's ref or url.");
export type MessagingAttachment = z.infer<typeof messagingAttachmentSchema>;

/** At most this many attachments on one inbound message. */
export const MESSAGING_ATTACHMENTS_MAX = 10;

/**
 * A buyer's message. `messageId` is the channel's own id: the platform applies
 * a message once per provider and id. `from.address` is where replies go:
 * E.164 on WhatsApp and Viber, the channel's own sender id otherwise.
 */
export const messagingInboundMessageSchema = z.object({
  type: z.literal("message"),
  channel: z.enum(MESSAGING_CHANNELS),
  messageId: providerRefSchema,
  from: z.object({
    address: z.string().min(1).max(128),
    /** The buyer's profile name on the channel. */
    name: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  /** When the buyer sent it (ISO 8601); the platform's receipt time when absent. */
  sentAt: z.iso.datetime({ offset: true }).optional(),
  text: z.string().min(1).max(4096).optional(),
  attachments: z.array(messagingAttachmentSchema).max(MESSAGING_ATTACHMENTS_MAX).optional(),
}).strict().refine((message) => message.text !== undefined || (message.attachments?.length ?? 0) > 0, "A message carries text or an attachment.");
export type MessagingInboundMessage = z.infer<typeof messagingInboundMessageSchema>;

/** A delivery receipt for a message the store sent (`providerRef` is what `send` answered). */
export const messagingReceiptSchema = z.object({
  type: z.literal("status"),
  providerRef: providerRefSchema,
  status: z.enum(["sent", "delivered", "read", "failed"]),
  rawStatus: rawStatus.optional(),
}).strict();
export type MessagingReceipt = z.infer<typeof messagingReceiptSchema>;

/** At most this many messages and receipts in one push (WhatsApp batches them). */
export const MESSAGING_WEBHOOK_EVENTS_MAX = 50;

/**
 * The answer the channel expects: the courier reply, or plain `text` (Meta's
 * subscription check echoes `hub.challenge`). Absent: `200 { received: true }`.
 */
export const messagingWebhookReplySchema = z.object({
  status: z.number().int().min(200).max(299),
  headers: courierWebhookReplySchema.shape.headers,
  body: courierWebhookReplySchema.shape.body,
  text: z.string().max(1024).optional(),
}).strict().refine((reply) => reply.body === undefined || reply.text === undefined, "Answer a body or text, not both.");
export type MessagingWebhookReply = z.infer<typeof messagingWebhookReplySchema>;

/**
 * An authenticated push, or why nothing applies. `events`: the messages and
 * receipts it carries; `ignored`: authentic but nothing for the inbox (a
 * subscription check, a typing indicator); `invalid`: not authentic (401),
 * or authentic but malformed with `rejectStatus`.
 */
export const messagingWebhookSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("events"),
    events: z.array(z.union([messagingInboundMessageSchema, messagingReceiptSchema])).min(1).max(MESSAGING_WEBHOOK_EVENTS_MAX),
    reply: messagingWebhookReplySchema.optional(),
  }).strict(),
  z.object({ status: z.literal("ignored"), reason: providerReasonSchema, reply: messagingWebhookReplySchema.optional() }).strict(),
  z.object({
    status: z.literal("invalid"),
    reason: providerReasonSchema,
    rejectStatus: z.number().int().min(400).max(499).optional(),
  }).strict(),
]);
export type MessagingWebhook = z.infer<typeof messagingWebhookSchema>;

export const MESSAGING_PORT = {
  send: { input: messagingSendInputSchema, output: messagingSendSchema },
  deliveryStatus: { input: messageStatusInputSchema, output: messageStatusSchema },
  verifyWebhook: { input: providerHttpRequestSchema, output: messagingWebhookSchema },
} as const;

/** Who a push notification goes to: staff users or buyers (customer ids). */
export const PUSH_AUDIENCES = ["staff", "customer"] as const;
export type PushAudience = (typeof PUSH_AUDIENCES)[number];

/** A notification: short text and the page it opens. Never contact data or secrets. */
export const pushNotificationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(500).default(""),
  /** An https URL or a same-site path (`/account/orders/…`). */
  url: z.string().max(2000).regex(/^(?:https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/).optional(),
  /** Replaces an earlier notification with the same tag on the device. */
  tag: z.string().regex(/^[a-z0-9_.:-]{1,64}$/).optional(),
}).strict();
export type PushNotification = z.infer<typeof pushNotificationSchema>;

export const pushSendInputSchema = z.object({
  audience: z.enum(PUSH_AUDIENCES),
  /** Scalius ids (staff user ids or customer ids); the provider maps them to its subscribers. */
  to: z.array(z.string().min(1).max(128)).min(1).max(100),
  notification: pushNotificationSchema,
  /** Deterministic per message: never send twice for one key. */
  idempotencyKey: providerIdempotencyKeySchema.optional(),
}).strict();
export type PushSendInput = z.infer<typeof pushSendInputSchema>;

export const pushSendSchema = z.object({
  success: z.boolean(),
  /** How many devices took it, when the provider knows. */
  delivered: z.number().int().min(0).max(1_000_000).optional(),
  providerRef: providerRefSchema.optional(),
  rawStatus: rawStatus.optional(),
  retryable: z.boolean().optional(),
}).strict();
export type PushSend = z.infer<typeof pushSendSchema>;

export const PUSH_PORT = {
  send: { input: pushSendInputSchema, output: pushSendSchema },
} as const;
