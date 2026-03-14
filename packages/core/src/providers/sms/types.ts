// packages/core/src/providers/sms/types.ts
// SMS provider interface.
//
// ============================================================================
// HOW TO ADD A NEW SMS PROVIDER
// ============================================================================
//
// 1. Create a new file: providers/sms/my-sms.ts
//
// 2. Implement the SMSProvider interface:
//
//    import { z } from "zod";
//    import type { SMSProvider, SendSMSOptions, SendSMSResult } from "../sms/types";
//    import { registerProvider } from "../registry";
//
//    const mySmsSettingsSchema = z.object({
//      apiKey: z.string().min(1),
//      senderId: z.string().min(1),
//    });
//    type MySmsSettings = z.infer<typeof mySmsSettingsSchema>;
//
//    export class MySmsProvider implements SMSProvider {
//      constructor(private settings: MySmsSettings) {}
//
//      async initialize() { /* validate API key */ }
//      async healthCheck() { return { healthy: true }; }
//
//      async sendSMS(options: SendSMSOptions): Promise<SendSMSResult> {
//        // Call your SMS API
//        return { messageId: "msg_123", status: "sent" };
//      }
//    }
//
// 3. Register the provider:
//
//    registerProvider(
//      {
//        id: "my-sms",
//        name: "My SMS Gateway",
//        type: "sms",
//        version: "1.0.0",
//        settingsSchema: mySmsSettingsSchema,
//        description: "Send SMS via My SMS Gateway",
//      },
//      (settings) => new MySmsProvider(settings),
//    );
//
// 4. Import your file from providers/sms/index.ts to ensure registration runs.
//
// 5. Done. Available via getProvider("sms", "my-sms", settings).
//
// ============================================================================

import type { ProviderLifecycle, HealthCheckResult } from "../types";

// ---------------------------------------------------------------------------
// SMS-specific types
// ---------------------------------------------------------------------------

/**
 * Options for sending a single SMS.
 */
export interface SendSMSOptions {
  /** Recipient phone number in E.164 format (e.g. "+8801712345678") */
  to: string;
  /** Message body text. Max length depends on provider (typically 160 chars for GSM-7). */
  message: string;
  /** Optional sender ID override (if your provider supports alphanumeric sender IDs) */
  senderId?: string;
}

/**
 * Result of sending an SMS.
 */
export interface SendSMSResult {
  /** Provider-assigned message ID for tracking */
  messageId?: string;
  /** Delivery status: "sent" (accepted by provider), "queued", or "failed" */
  status: "sent" | "queued" | "failed";
  /** Error message if status is "failed" */
  error?: string;
}

/**
 * Options for sending a templated SMS.
 * Some providers (e.g. Twilio, AWS SNS) support server-side templates.
 */
export interface SendTemplateSMSOptions {
  /** Recipient phone number in E.164 format */
  to: string;
  /** Provider-specific template ID */
  templateId: string;
  /** Template variable substitutions */
  params: Record<string, string>;
  /** Optional sender ID override */
  senderId?: string;
}

// ---------------------------------------------------------------------------
// SMSProvider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every SMS provider must implement.
 *
 * Required: sendSMS.
 * Optional: sendTemplate (for providers with server-side templates).
 */
export interface SMSProvider extends ProviderLifecycle {
  /**
   * Send a single SMS message.
   * This is the primary method for all SMS communication.
   */
  sendSMS(options: SendSMSOptions): Promise<SendSMSResult>;

  /**
   * Send an SMS using a provider-hosted template.
   * Optional -- only implement if your provider supports server-side templates.
   */
  sendTemplate?(options: SendTemplateSMSOptions): Promise<SendSMSResult>;

  /**
   * Check the delivery status of a previously sent message.
   * Optional -- not all providers support delivery receipts.
   */
  getDeliveryStatus?(messageId: string): Promise<{
    status: "delivered" | "sent" | "failed" | "unknown";
    updatedAt?: Date;
  }>;
}

// Re-export lifecycle types for convenience
export type { ProviderLifecycle, HealthCheckResult };
