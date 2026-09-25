// Customer identity: the one settings document (Dashboard → Settings →
// Customer accounts) that decides what checkout collects and how a buyer
// proves who they are. Every surface (checkout fields, account sign-in, Track
// your order, payment recovery, API validation) reads this shape and these
// helpers; nothing else decides contact fields or code channels.
//
// Phone is always collected and required (couriers need it; AGENTS.md).

export const CUSTOMER_AUTH_OTP_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const EMAIL_COLLECTION_MODES = ["required", "optional", "hidden"] as const;
export const WHATSAPP_COLLECTION_MODES = ["off", "same_as_phone", "separate"] as const;

export type CustomerAuthOtpChannel = (typeof CUSTOMER_AUTH_OTP_CHANNELS)[number];
export type EmailCollectionMode = (typeof EMAIL_COLLECTION_MODES)[number];
export type WhatsAppCollectionMode = (typeof WHATSAPP_COLLECTION_MODES)[number];
/** What a buyer types to sign in: an email address or a phone number. */
export type CustomerAuthRequestMethod = "email" | "phone";
export type FieldNeed = "required" | "optional" | "hidden";

export interface CustomerIdentitySettings {
  email: EmailCollectionMode;
  whatsapp: WhatsAppCollectionMode;
  /** The code channels the merchant chose, in their order. Never empty. */
  channels: CustomerAuthOtpChannel[];
}

/** A new store: email optional at checkout, sign-in codes by email. */
export const DEFAULT_CUSTOMER_IDENTITY: Readonly<CustomerIdentitySettings> = Object.freeze({
  email: "optional",
  whatsapp: "off",
  channels: ["email"],
}) as Readonly<CustomerIdentitySettings>;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isCustomerAuthOtpChannel(value: unknown): value is CustomerAuthOtpChannel {
  return isOneOf(CUSTOMER_AUTH_OTP_CHANNELS, value);
}

/** The buyer's contact a channel sends to. */
export function channelContactField(channel: CustomerAuthOtpChannel): "email" | "phone" | "whatsapp" {
  return channel === "email" ? "email" : channel === "sms" ? "phone" : "whatsapp";
}

/** Email codes are requested with an email address; SMS and WhatsApp codes with a phone number. */
export function channelRequestMethod(channel: CustomerAuthOtpChannel): CustomerAuthRequestMethod {
  return channel === "email" ? "email" : "phone";
}

/** A channel can be chosen only when checkout collects the contact it sends to. */
export function isChannelCollected(
  settings: Pick<CustomerIdentitySettings, "email" | "whatsapp">,
  channel: CustomerAuthOtpChannel,
): boolean {
  if (channel === "email") return settings.email !== "hidden";
  if (channel === "whatsapp") return settings.whatsapp !== "off";
  return true;
}

/**
 * Why a settings change can't be saved, or null. Readiness (a configured
 * provider) is checked by the caller; this is the shape rule only.
 */
export function customerIdentityProblem(settings: CustomerIdentitySettings): string | null {
  if (settings.channels.length === 0) return "Choose at least one way to send codes.";
  const uncollected = settings.channels.find((channel) => !isChannelCollected(settings, channel));
  if (uncollected === "email") return "Email codes need checkout to ask for the email address.";
  if (uncollected === "whatsapp") return "WhatsApp codes need checkout to ask for a WhatsApp number.";
  return null;
}

/**
 * The stored document, validated. Anything that isn't exactly this shape (an
 * older format, a hand edit) resets to the defaults: no tolerant reads.
 */
export function normalizeCustomerIdentitySettings(value: unknown): CustomerIdentitySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cloneDefault();
  const input = value as Record<string, unknown>;
  if (!isOneOf(EMAIL_COLLECTION_MODES, input.email) || !isOneOf(WHATSAPP_COLLECTION_MODES, input.whatsapp)) {
    return cloneDefault();
  }
  if (!Array.isArray(input.channels)) return cloneDefault();
  const channels = [...new Set(input.channels.filter(isCustomerAuthOtpChannel))];
  const settings: CustomerIdentitySettings = { email: input.email, whatsapp: input.whatsapp, channels };
  return customerIdentityProblem(settings) ? cloneDefault() : settings;
}

function cloneDefault(): CustomerIdentitySettings {
  return { ...DEFAULT_CUSTOMER_IDENTITY, channels: [...DEFAULT_CUSTOMER_IDENTITY.channels] };
}

export type ChannelReadiness = Record<CustomerAuthOtpChannel, boolean>;

/** The chosen channels that can send right now. Nothing is added that the merchant didn't choose. */
export function offeredChannels(
  settings: CustomerIdentitySettings,
  ready: Partial<ChannelReadiness>,
): CustomerAuthOtpChannel[] {
  return settings.channels.filter((channel) => ready[channel] === true);
}

/**
 * The channel a sign-in request uses: the requested one when the merchant
 * chose it and it matches what the buyer typed, else the first chosen channel
 * for that kind of contact. Null when the store doesn't offer it.
 */
export function resolveSignInChannel(
  channels: readonly CustomerAuthOtpChannel[],
  method: CustomerAuthRequestMethod,
  requested?: unknown,
): CustomerAuthOtpChannel | null {
  if (isCustomerAuthOtpChannel(requested) && channels.includes(requested) && channelRequestMethod(requested) === method) {
    return requested;
  }
  return channels.find((channel) => channelRequestMethod(channel) === method) ?? null;
}

/** What the checkout contact section shows. Phone is always required. */
export function checkoutContactFields(settings: Pick<CustomerIdentitySettings, "email" | "whatsapp">): {
  email: FieldNeed;
  /** A separate WhatsApp number field (optional); hidden when WhatsApp is off or is the phone. */
  whatsapp: "optional" | "hidden";
} {
  return {
    email: settings.email,
    whatsapp: settings.whatsapp === "separate" ? "optional" : "hidden",
  };
}

export interface OrderContactForCodes {
  customerPhone: string;
  customerEmail: string | null;
  customerWhatsapp?: string | null;
}

/** Where a channel's code for an order goes: always a contact saved on the order, never one the visitor typed. */
export function orderChannelTarget(
  settings: Pick<CustomerIdentitySettings, "whatsapp">,
  channel: CustomerAuthOtpChannel,
  order: OrderContactForCodes,
): string | null {
  if (channel === "email") return order.customerEmail?.trim().toLowerCase() || null;
  if (channel === "sms") return order.customerPhone?.trim() || null;
  if (settings.whatsapp === "off") return null;
  const whatsapp = settings.whatsapp === "separate" ? order.customerWhatsapp?.trim() : "";
  return whatsapp || order.customerPhone?.trim() || null;
}

/** The chosen channels that can reach this order's contacts, in the merchant's order. */
export function orderCodeChannels(
  settings: CustomerIdentitySettings,
  order: OrderContactForCodes,
): Array<{ channel: CustomerAuthOtpChannel; target: string }> {
  return settings.channels.flatMap((channel) => {
    const target = orderChannelTarget(settings, channel, order);
    return target ? [{ channel, target }] : [];
  });
}

/** Queue consumers still route WhatsApp by this legacy method name. */
export function channelToAllowedMethod(channel: CustomerAuthOtpChannel): string {
  if (channel === "whatsapp") return "whatsapp_otp";
  if (channel === "sms") return "sms_otp";
  return "email";
}
