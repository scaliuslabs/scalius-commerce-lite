// Customer identity: the one settings document (Dashboard → Settings →
// Customer accounts) that decides what checkout collects and how a buyer
// proves who they are. Every surface (checkout fields, account sign-in, Track
// your order, payment recovery, API validation) reads this shape and these
// helpers; nothing else decides contact fields or code channels.
//
// Phone is required for every order that is delivered, picked up, paid in
// cash or by deposit, or placed in Bangladesh. A merchant may opt in to make
// it optional only for orders made entirely of digital or service lines;
// email is then required ({@link orderContactNeeds}).
//
// Storage keeps NOT NULL phone columns: a phoneless contact is stored as
// {@link NO_PHONE} and read back as null. Only {@link storedPhone} and
// {@link phoneOrNull} cross that line; nothing else compares with ''.

import type { FulfillmentKind } from "./fulfilment";

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
  /**
   * The merchant's opt-in: a phone is optional for an order made only of
   * digital or service lines (email is then required). Off by default.
   */
  phoneOptionalForDigital: boolean;
}

/** A new store: email optional at checkout, sign-in codes by email, phone always required. */
export const DEFAULT_CUSTOMER_IDENTITY: Readonly<CustomerIdentitySettings> = Object.freeze({
  email: "optional",
  whatsapp: "off",
  channels: ["email"],
  phoneOptionalForDigital: false,
}) as Readonly<CustomerIdentitySettings>;

// ── Checkout sign-in ───────────────────────────────────────────────────────

/**
 * Set on a placed order's response when the request carried a customer
 * session that no longer signs anyone in: the order was placed as a guest's
 * and the storefront clears its session cookies.
 */
export const CUSTOMER_SESSION_ENDED_HEADER = "X-Customer-Session-Ended";

/** What a buyer reads when the store sells only to signed-in customers. */
export const CUSTOMER_SIGN_IN_REQUIRED_MESSAGE = "Sign in to place your order. This store sells only to signed-in customers.";

// ── Stored phones ──────────────────────────────────────────────────────────

/**
 * How a contact without a phone is stored in the NOT NULL phone columns
 * (`customers.phone`, `orders.customer_phone`, `customer_history.phone`).
 * Never shown, sent or matched: read it back with {@link phoneOrNull}.
 */
export const NO_PHONE = "";

/** The value a phone column stores: the phone, or {@link NO_PHONE}. */
export function storedPhone(phone: string | null | undefined): string {
  return phone?.trim() || NO_PHONE;
}

/** A stored phone as the domain sees it: the phone, or null when there is none. */
export function phoneOrNull(stored: string | null | undefined): string | null {
  return stored?.trim() || null;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isCustomerAuthOtpChannel(value: unknown): value is CustomerAuthOtpChannel {
  return isOneOf(CUSTOMER_AUTH_OTP_CHANNELS, value);
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
  // A buyer without a phone is reached by email only: receipts, downloads,
  // sign-in and payment recovery all need it.
  if (settings.phoneOptionalForDigital && settings.email === "hidden") {
    return "Orders without a phone need checkout to ask for the email address.";
  }
  if (settings.phoneOptionalForDigital && !settings.channels.includes("email")) {
    return "Orders without a phone need email codes, so those buyers can sign in and find their orders.";
  }
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
  // Absent is the default (off): a document saved before the opt-in existed.
  if (input.phoneOptionalForDigital !== undefined && typeof input.phoneOptionalForDigital !== "boolean") {
    return cloneDefault();
  }
  const channels = [...new Set(input.channels.filter(isCustomerAuthOtpChannel))];
  const settings: CustomerIdentitySettings = {
    email: input.email,
    whatsapp: input.whatsapp,
    channels,
    phoneOptionalForDigital: input.phoneOptionalForDigital === true,
  };
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

/**
 * What the checkout contact section shows before the order is known. The
 * phone field is always shown; whether this order needs it is
 * {@link orderContactNeeds}.
 */
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

// ── The order's contact rule ───────────────────────────────────────────────

/** What one order line is: a variant's kind, and whether it is a gift card. */
export interface OrderContactLine {
  fulfillmentKind: FulfillmentKind;
  isGiftCard: boolean;
}

/**
 * How the order is paid:
 * - `cod`: cash on delivery, at pickup or at the service;
 * - `partial`: a deposit online now and the rest later (a deposit plan or EMI);
 * - `online`: the whole amount online now;
 * - `gift_card`: gift cards cover the whole order.
 */
export type OrderPaymentKind = "cod" | "online" | "partial" | "gift_card";

/** Why an order needs a phone. */
export type PhoneRequiredReason =
  /** The merchant has not opted in. */
  | "not_opted_in"
  /** Checkout doesn't ask for email, so no other contact reaches the buyer. */
  | "email_hidden"
  /** The order has no lines yet. */
  | "no_lines"
  /** A line is delivered or picked up. */
  | "delivery"
  | "cash_on_delivery"
  | "partial_payment"
  /** The order is placed in Bangladesh (its market or shipping country). */
  | "bangladesh";

export interface OrderContactInput {
  lines: readonly OrderContactLine[];
  payment: OrderPaymentKind;
  /**
   * The order's country: its shipping country, else its market's. Null or
   * unknown counts as Bangladesh (the backup market's delivery country).
   */
  countryCode: string | null | undefined;
}

export interface OrderContactNeeds {
  phone: "required" | "optional";
  /** "required" whenever the phone is optional: the buyer always keeps a contact. */
  email: FieldNeed;
  /** Null when the phone is optional. */
  phoneReason: PhoneRequiredReason | null;
}

/** The country whose orders always need a phone (couriers, COD, OTP by SMS). */
export const PHONE_REQUIRED_COUNTRY = "BD";

/** How the order is paid, from its payment method and the store's deposit plan. */
export function orderPaymentKind(
  paymentMethod: string,
  options: {
    /** The store takes an advance deposit online (partial payment). */
    depositPlan: boolean;
  },
): OrderPaymentKind {
  if (paymentMethod === "cod") return "cod";
  if (paymentMethod === "gift_card") return "gift_card";
  return options.depositPlan ? "partial" : "online";
}

/**
 * The one rule for an order's contact (owner decision 2026-10-07). A phone
 * is optional only when the merchant opted in, checkout asks for email, and
 * every line is digital, a service or a gift card that is paid in full now,
 * outside Bangladesh. Then email is required. Every other order needs a
 * phone, and its email follows the merchant's setting.
 */
export function orderContactNeeds(
  settings: Pick<CustomerIdentitySettings, "email" | "phoneOptionalForDigital">,
  order: OrderContactInput,
): OrderContactNeeds {
  const reason = phoneRequiredReason(settings, order);
  return reason
    ? { phone: "required", email: settings.email, phoneReason: reason }
    : { phone: "optional", email: "required", phoneReason: null };
}

function phoneRequiredReason(
  settings: Pick<CustomerIdentitySettings, "email" | "phoneOptionalForDigital">,
  order: OrderContactInput,
): PhoneRequiredReason | null {
  if (settings.phoneOptionalForDigital !== true) return "not_opted_in";
  if (settings.email === "hidden") return "email_hidden";
  if (order.lines.length === 0) return "no_lines";
  if (order.lines.some((line) => !line.isGiftCard && line.fulfillmentKind === "physical")) return "delivery";
  if (order.payment === "cod") return "cash_on_delivery";
  if (order.payment === "partial") return "partial_payment";
  const country = order.countryCode?.trim().toUpperCase() || PHONE_REQUIRED_COUNTRY;
  if (country === PHONE_REQUIRED_COUNTRY) return "bangladesh";
  return null;
}

/**
 * Whether a new account must give a phone. An account signed up by phone has
 * one. An account signed up by email may skip it only when the merchant
 * opted in to orders without a phone; each order still follows
 * {@link orderContactNeeds} and asks for a phone when it needs one.
 */
export function newAccountPhoneNeed(
  settings: Pick<CustomerIdentitySettings, "phoneOptionalForDigital">,
  method: CustomerAuthRequestMethod,
): "required" | "optional" {
  return method === "email" && settings.phoneOptionalForDigital === true ? "optional" : "required";
}

export interface OrderContactForCodes {
  /** Null for an order placed without a phone. */
  customerPhone: string | null;
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
  if (channel === "sms") return phoneOrNull(order.customerPhone);
  if (settings.whatsapp === "off") return null;
  const whatsapp = settings.whatsapp === "separate" ? order.customerWhatsapp?.trim() : "";
  return whatsapp || phoneOrNull(order.customerPhone);
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
