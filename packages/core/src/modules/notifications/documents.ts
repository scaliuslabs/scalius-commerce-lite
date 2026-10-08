// src/modules/notifications/documents.ts
// The notifications domain's settings documents: which channels each order
// and staff event uses (with their defaults and allowances), the staff email
// recipients, the order WhatsApp template, and the merchant's message copy.

import { z } from "zod";
import { defineSettingsDocument } from "../../settings-store";
import {
  NOTIFICATION_TYPES,
  TEMPLATED_NOTIFICATION_TYPES,
  adminChannelsForType,
  customerChannelsForType,
  isNotificationType,
  type NotificationType,
} from "./notification-types";
import {
  TEMPLATE_LIMITS,
  type NotificationTemplateOverrides,
} from "./notification-templates";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export type NotificationChannelRules = Record<string, string[]>;

/**
 * Buyer defaults: email for every buyer message; ready-for-pickup, digital
 * delivery and gift cards also text; review requests are email only (an SMS
 * costs the merchant). Staff alerts never reach the buyer (Wave B §10).
 */
function defaultCustomerChannels(type: NotificationType): string[] {
  if (type === "conversation_message" || type === "review_pending" || type === "digital_keys_exhausted") return [];
  if (type === "order_ready_for_pickup" || type === "order_digital_delivered" || type === "gift_card_issued") {
    return ["email", "sms"];
  }
  return ["email"];
}

/**
 * Staff defaults: push for new and cancelled orders, support requests, buyer
 * messages and reviews waiting for approval; push and email when a licence
 * key pool runs out.
 */
function defaultAdminChannels(type: NotificationType): string[] {
  if (type === "digital_keys_exhausted") return ["push", "email"];
  return type === "order_created"
    || type === "order_cancelled"
    || type === "support_request_submitted"
    || type === "conversation_message"
    || type === "review_pending"
    ? ["push"]
    : [];
}

export const DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, defaultCustomerChannels(type)]),
);

export const DEFAULT_ADMIN_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, defaultAdminChannels(type)]),
);

/** The channels an event may keep: a fixed list, a per-event rule, or anything (null). */
export type NotificationChannelAllowance =
  | readonly string[]
  | ((event: NotificationType) => readonly string[])
  | null;

/** Buyer channels per event (thread replies never use the order WhatsApp template). */
export const CUSTOMER_CHANNEL_ALLOWANCE: NotificationChannelAllowance = customerChannelsForType;
/** Staff channels per event (staff email only for buyer messages). */
export const ADMIN_CHANNEL_ALLOWANCE: NotificationChannelAllowance = adminChannelsForType;

/**
 * Accepts the dashboard's boolean maps (optionally wrapped in `{ channels }`)
 * or canonical string arrays; unknown events and, unless `allowed` is null,
 * channels the event may not use are dropped.
 */
export function normalizeNotificationChannelRules(
  value: unknown,
  defaults: NotificationChannelRules,
  allowed: NotificationChannelAllowance,
): NotificationChannelRules {
  if (!value || typeof value !== "object") return { ...defaults };
  const root = value as JsonRecord;
  const record = root.channels ? asRecord(root.channels) : root;
  const result: NotificationChannelRules = { ...defaults };
  for (const [event, entry] of Object.entries(record)) {
    if (!isNotificationType(event)) continue;
    const channels = Array.isArray(entry)
      ? entry.filter((channel): channel is string => typeof channel === "string")
      : entry && typeof entry === "object"
        ? Object.entries(entry as Record<string, unknown>)
          .filter(([, enabled]) => enabled)
          .map(([channel]) => channel)
        : null;
    if (!channels) continue;
    const permitted = typeof allowed === "function" ? allowed(event) : allowed;
    result[event] = permitted ? channels.filter((channel) => permitted.includes(channel)) : channels;
  }
  return result;
}

export const STAFF_EMAIL_RECIPIENTS_MAX = 10;

export interface NotificationSettings {
  orderChannels: NotificationChannelRules;
  adminChannels: NotificationChannelRules;
  /** Staff who get an email for every new order. */
  staffEmailRecipients: string[];
  whatsappOrderTemplateName: string;
  whatsappOrderTemplateLanguage: string;
  /**
   * Who delivers buyers' browser notifications: "" for Web Push (built in),
   * or an app push provider (`<plugin id>:<provider id>`) with its own
   * subscribers. Staff pushes always use Web Push and Firebase.
   */
  pushProvider: string;
}

export const notificationsDocument = defineSettingsDocument<NotificationSettings>({
  key: "notifications",
  schema: z.object({
    orderChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
      CUSTOMER_CHANNEL_ALLOWANCE,
    )),
    adminChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
      ADMIN_CHANNEL_ALLOWANCE,
    )),
    staffEmailRecipients: z.array(z.string().max(254)).max(STAFF_EMAIL_RECIPIENTS_MAX),
    whatsappOrderTemplateName: z.string(),
    whatsappOrderTemplateLanguage: z.string(),
    pushProvider: z.string().max(160),
  }),
  defaults: {
    orderChannels: DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
    adminChannels: DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
    staffEmailRecipients: [],
    whatsappOrderTemplateName: "order_status_update",
    whatsappOrderTemplateLanguage: "en_US",
    pushProvider: "",
  },
});

/** Customer message copy the merchant changed; a missing event uses the default. */
export const notificationTemplatesDocument = defineSettingsDocument<NotificationTemplateOverrides>({
  key: "notification_templates",
  schema: z.object({
    email: z.partialRecord(z.enum(TEMPLATED_NOTIFICATION_TYPES), z.object({
      subject: z.string().max(TEMPLATE_LIMITS.subject),
      body: z.string().max(TEMPLATE_LIMITS.emailBody),
    })),
    sms: z.partialRecord(z.enum(TEMPLATED_NOTIFICATION_TYPES), z.object({
      body: z.string().max(TEMPLATE_LIMITS.smsBody),
    })),
  }),
  defaults: { email: {}, sms: {} },
});
