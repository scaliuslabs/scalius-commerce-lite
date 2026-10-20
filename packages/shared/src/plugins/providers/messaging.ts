// The SMS and email ports. Every send port (sms, email, messaging, push)
// names the recipient `to`, the plain text `text` and the per-message key
// `idempotencyKey`. A send that the provider refused or could not take
// answers `success: false` (with `retryable: false` for account,
// template or recipient errors the same message can never pass); the
// notification queue retries the rest. Throwing a `ProviderError` means the
// same: `retryable` stays retryable, `declined` and `misconfigured` do not.

import { z } from "zod";
import { providerIdempotencyKeySchema, providerRefSchema } from "./common";

const rawStatus = z.string().max(300);

export const smsSendInputSchema = z.object({
  /** E.164 (`+8801XXXXXXXXX`). */
  to: z.string().min(4).max(20),
  /** Plain text. */
  text: z.string().min(1).max(2000),
  /** Deterministic per message: never send twice for one key. */
  idempotencyKey: providerIdempotencyKeySchema.optional(),
}).strict();
export type SmsSendInput = z.infer<typeof smsSendInputSchema>;

export const smsSendSchema = z.object({
  success: z.boolean(),
  providerRef: providerRefSchema.optional(),
  rawStatus: rawStatus.optional(),
  /** False for errors a retry can never fix (bad credentials, invalid number). */
  retryable: z.boolean().optional(),
}).strict();
export type SmsSend = z.infer<typeof smsSendSchema>;

export const emailSendInputSchema = z.object({
  to: z.string().min(3).max(320),
  subject: z.string().min(1).max(998),
  html: z.string().max(1024 * 1024),
  text: z.string().max(1024 * 1024).optional(),
  /** The sender address; the store's verified sender when absent. */
  from: z.string().max(320).optional(),
  fromName: z.string().max(200).optional(),
  /** Only the list headers marketing mail needs (`List-Unsubscribe`, `List-Unsubscribe-Post`), each optional. */
  headers: z.partialRecord(z.enum(["List-Unsubscribe", "List-Unsubscribe-Post"]), z.string().max(2000)).optional(),
  /** Deterministic per message: never send twice for one key. */
  idempotencyKey: providerIdempotencyKeySchema.optional(),
}).strict();
export type EmailSendInput = z.infer<typeof emailSendInputSchema>;

export const emailSendSchema = z.object({
  success: z.boolean(),
  providerRef: providerRefSchema.optional(),
  rawStatus: rawStatus.optional(),
  retryable: z.boolean().optional(),
}).strict();
export type EmailSend = z.infer<typeof emailSendSchema>;

export const messageStatusInputSchema = z.object({ providerRef: providerRefSchema }).strict();
export const messageStatusSchema = z.object({
  status: z.enum(["queued", "sent", "delivered", "failed", "unknown"]),
  rawStatus: rawStatus.optional(),
}).strict();
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const SMS_PORT = {
  send: { input: smsSendInputSchema, output: smsSendSchema },
  deliveryStatus: { input: messageStatusInputSchema, output: messageStatusSchema },
} as const;

export const EMAIL_PORT = {
  send: { input: emailSendInputSchema, output: emailSendSchema },
  deliveryStatus: { input: messageStatusInputSchema, output: messageStatusSchema },
} as const;
