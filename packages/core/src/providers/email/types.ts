// packages/core/src/providers/email/types.ts
// Email provider interface.
//
// ============================================================================
// HOW TO ADD A NEW EMAIL PROVIDER
// ============================================================================
//
// 1. Create a new file: providers/email/my-provider.ts
//
// 2. Implement the EmailProvider interface:
//
//    import { z } from "zod";
//    import type { EmailProvider, SendEmailOptions, SendEmailResult } from "../email/types";
//    import { registerProvider } from "../registry";
//
//    const myProviderSettingsSchema = z.object({
//      apiKey: z.string().min(1),
//      defaultFrom: z.string().email(),
//    });
//    type MyProviderSettings = z.infer<typeof myProviderSettingsSchema>;
//
//    export class MyEmailProvider implements EmailProvider {
//      constructor(private settings: MyProviderSettings) {}
//
//      async initialize() { /* validate API key, etc. */ }
//      async healthCheck() { return { healthy: true }; }
//
//      async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
//        // Call your email API
//        return { messageId: "msg_123" };
//      }
//    }
//
// 3. Register the provider:
//
//    registerProvider(
//      {
//        id: "my-provider",
//        name: "My Email Provider",
//        type: "email",
//        version: "1.0.0",
//        settingsSchema: myProviderSettingsSchema,
//        description: "Send transactional emails via My Provider",
//      },
//      (settings) => new MyEmailProvider(settings),
//    );
//
// 4. Import your file from providers/email/index.ts to ensure registration runs.
//
// 5. Done. Available via getProvider("email", "my-provider", settings).
//
// ============================================================================

import type { ProviderLifecycle, HealthCheckResult } from "../types";

// ---------------------------------------------------------------------------
// Email-specific types
// ---------------------------------------------------------------------------

/**
 * Options for sending a single email.
 */
export interface SendEmailOptions {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** HTML body content */
  html: string;
  /** Override the default sender address */
  from?: string;
  /** Optional plain-text fallback body */
  text?: string;
  /** Optional reply-to address */
  replyTo?: string;
  /** Optional CC recipients */
  cc?: string[];
  /** Optional BCC recipients */
  bcc?: string[];
  /** Optional email tags for analytics/filtering */
  tags?: string[];
}

/**
 * Result of sending an email.
 */
export interface SendEmailResult {
  /** Provider-assigned message ID for tracking */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// EmailProvider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every email provider must implement.
 *
 * The only required method is sendEmail(). Template support is optional.
 */
export interface EmailProvider extends ProviderLifecycle {
  /**
   * Send a single email with raw HTML content.
   * This is the primary method -- all convenience functions (verification emails,
   * password reset, etc.) ultimately call this.
   */
  sendEmail(options: SendEmailOptions): Promise<SendEmailResult>;

  /**
   * Send an email using a provider-hosted template.
   * Optional -- only implement if your provider supports server-side templates
   * (e.g. SendGrid dynamic templates, Mailgun templates).
   */
  sendTemplated?(
    to: string,
    templateId: string,
    data: Record<string, unknown>,
    options?: { from?: string; subject?: string },
  ): Promise<SendEmailResult>;
}

// Re-export lifecycle types for convenience
export type { ProviderLifecycle, HealthCheckResult };
