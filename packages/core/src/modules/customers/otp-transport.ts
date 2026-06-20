// src/modules/customers/otp-transport.ts
// OTP transport abstraction — each transport knows how to build the queue
// payload for its delivery channel (email, SMS, WhatsApp).
// The queue consumer in apps/api/src/queue-consumer.ts dispatches based on
// the `method` + `channel` fields in the payload. Provider secrets are
// resolved at send time and must not be serialized into queues.

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
  deliveryKey: string;
  purpose?: string;
  otpExpiresAt?: number;
  method: "email" | "phone";
  allowedMethod: string;
  channel?: CustomerAuthOtpChannel;
  identifier: string;
  code: string;
  name: string;
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
    code: string,
    identifier: string,
    name: string,
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
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
    code: string,
    identifier: string,
    name: string,
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "email",
      allowedMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod),
      channel,
      identifier,
      code,
      name,
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
    code: string,
    identifier: string,
    name: string,
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "phone",
      allowedMethod: normalizeCustomerAuthMethod(settings.authVerificationMethod),
      channel,
      identifier,
      code,
      name,
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
    code: string,
    identifier: string,
    name: string,
    settings: SiteSettings,
    channel: CustomerAuthOtpChannel,
    deliveryKey: string,
    otpExpiresAt: number,
  ): OtpQueuePayload {
    return {
      type: "auth.send_otp",
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt,
      method: "phone",
      allowedMethod: "whatsapp_otp",
      channel,
      identifier,
      code,
      name,
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
