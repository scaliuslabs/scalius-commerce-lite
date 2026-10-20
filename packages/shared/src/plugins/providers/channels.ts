// The messaging and push ports (docs/platform/PLUGINS.md, "Providers").
//
// Messaging: chat channels (WhatsApp, Messenger, Instagram, Telegram,
// Viber). A provider declares the channels it carries (`channels`). Core
// sends a store's buyer messages on a channel through the provider the
// merchant chose for it; the built-in WhatsApp sender (Meta Cloud API) is
// the default for WhatsApp. Inbound messages (an inbox) are planned on the
// same kind: they add optional operations, so this port changes only
// additively.
//
// Push: notifications to a person's devices. Web Push (VAPID) is built in
// and needs no provider; an app push provider (a push service with its own
// subscriber list) receives the recipients by Scalius id and maps them to
// its own subscribers.
//
// A send answers `success: false` (with `retryable: false` when the same
// message can never pass), or throws a `ProviderError`, as the SMS port does.

import { z } from "zod";
import { providerIdempotencyKeySchema, providerRefSchema } from "./common";
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

export const MESSAGING_PORT = {
  send: { input: messagingSendInputSchema, output: messagingSendSchema },
  deliveryStatus: { input: messageStatusInputSchema, output: messageStatusSchema },
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
