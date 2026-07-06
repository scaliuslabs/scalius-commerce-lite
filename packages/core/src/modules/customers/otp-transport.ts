// src/modules/customers/otp-transport.ts
// OTP transport abstraction — each transport knows how to build the queue
// payload for its delivery channel (email, SMS, WhatsApp).
// The queue consumer in apps/api/src/queue-consumer.ts dispatches based on
// the `method` + `channel` fields in the payload. Provider secrets are
// resolved at send time; provider secrets and raw OTP codes must not be
// serialized into queues.

import type { SiteSettings } from "@scalius/database/schema";
import {
  type CustomerAuthOtpChannel,
  getCustomerAuthDeliveryChannel,
  normalizeCustomerAuthMethod,
} from "@scalius/shared/customer-auth-policy";

// ─────────────────────────────────────────
// Queue payload shape (matches AuthOtpQueueMessage in queue-consumer.ts)
// ─────────────────────────────────────────

export interface OtpQueuePayload {
  type: "auth.send_otp";
  challengeKey: string;
  deliveryKey: string;
  purpose?: string;
  otpExpiresAt?: number;
  method: "email" | "phone";
  allowedMethod: string;
  channel?: CustomerAuthOtpChannel;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  identifier?: string;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  code?: string;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  name?: string;
}

// ─────────────────────────────────────────
// Transport interface
// ─────────────────────────────────────────

export interface OtpTransport {
  /** The internal method name used in routing (e.g. "email", "phone") */
  readonly method: "email" | "phone";

  /** Human-readable label for success messages */
  readonly label: string;

  /** Build the queue payload for sending the OTP via this transport */
  buildQueuePayload(
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
    challengeKey: string,
  ): OtpQueuePayload;

  /**
   * Validate that the transport has the required configuration.
   * Returns an error message if misconfigured, or null if ready.
   */
  validateConfig(settings: SiteSettings): string | null;
}

// ─────────────────────────────────────────
// Concrete transports
// ─────────────────────────────────────────

export class EmailOtpTransport implements OtpTransport {
  readonly method = "email" as const;
  readonly label = "email";

  buildQueuePayload(
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
    challengeKey: string,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "email",
      allowedMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod),
      channel,
    };
  }

  validateConfig(_settings: SiteSettings): string | null {
    // Email transport uses the global email integration; no per-transport config needed.
    return null;
  }
}

export class SmsOtpTransport implements OtpTransport {
  readonly method = "phone" as const;
  readonly label = "SMS";

  buildQueuePayload(
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
    challengeKey: string,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "phone",
      allowedMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod),
      channel,
    };
  }

  validateConfig(_settings: SiteSettings): string | null {
    // SMS provider integration is pending (see queue-consumer TODO).
    return null;
  }
}

export class WhatsAppOtpTransport implements OtpTransport {
  readonly method = "phone" as const;
  readonly label = "WhatsApp";

  buildQueuePayload(
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
    challengeKey: string,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "phone",
      allowedMethod: "whatsapp_otp",
      channel,
    };
  }

  validateConfig(_settings: SiteSettings): string | null {
    // Customer auth validates encrypted WhatsApp credentials before queueing.
    return null;
  }
}

// ─────────────────────────────────────────
// Transport registry & factory
// ─────────────────────────────────────────

const emailTransport = new EmailOtpTransport();
const smsTransport = new SmsOtpTransport();
const whatsAppTransport = new WhatsAppOtpTransport();

/**
 * Resolve the correct OtpTransport based on the requested method and the
 * store's `authVerificationMethod` setting.
 *
 * @param method  - "email" or "phone" (from the customer's request)
 * @param allowedMethod - the `authVerificationMethod` value from site_settings
 */
export function getOtpTransport(
  method: "email" | "phone",
  allowedMethod: unknown,
  requestedChannel?: CustomerAuthOtpChannel,
): OtpTransport {
  const channel = getCustomerAuthDeliveryChannel(allowedMethod, method, requestedChannel);
  if (channel === "email") {
    return emailTransport;
  }
  if (channel === "whatsapp") {
    return whatsAppTransport;
  }
  return smsTransport;
}
