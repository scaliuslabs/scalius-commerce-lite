// packages/core/src/providers/email/resend-adapter.ts
// CANONICAL Resend email provider — the universal provider implementation.
//
// This file:
// 1. Defines a Zod settings schema for Resend
// 2. Implements EmailProvider with validated settings passed at construction
// 3. Registers it with the universal provider registry
//
// The legacy ResendEmailProvider in integrations/email/resend.ts reads settings
// from DB on every send and is retained only for backward compatibility.

import { z } from "zod";
import { registerProvider } from "../registry";
import type {
  EmailProvider,
  SendEmailOptions,
  SendEmailResult,
  HealthCheckResult,
} from "./types";

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

export const resendSettingsSchema = z.object({
  apiKey: z.string().min(1, "Resend API key is required"),
  defaultFrom: z.string().default("noreply@example.com"),
});

export type ResendProviderSettings = z.infer<typeof resendSettingsSchema>;

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Resend email provider for the universal provider system.
 *
 * Unlike the legacy ResendEmailProvider (which reads settings from DB on every
 * send), this version receives validated settings at construction time.
 * This is more explicit and testable.
 */
class ResendEmailProvider implements EmailProvider {
  private settings: ResendProviderSettings;

  constructor(settings: ResendProviderSettings) {
    this.settings = settings;
  }

  // -- Lifecycle --

  async initialize(): Promise<void> {
    // Resend is stateless REST API -- no initialization needed.
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.settings.apiKey) {
      return { healthy: false, message: "Resend API key not configured" };
    }
    return { healthy: true, message: "Resend API key configured" };
  }

  // -- Email operations --

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const fromAddress = options.from || this.settings.defaultFrom;

    if (!this.settings.apiKey) {
      // Dev fallback: log instead of sending
      console.log("=".repeat(60));
      console.log("EMAIL (Resend API key not configured - logging only)");
      console.log("=".repeat(60));
      console.log(`From: ${fromAddress}`);
      console.log(`To: ${options.to}`);
      console.log(`Subject: ${options.subject}`);
      console.log("-".repeat(60));
      console.log(options.html);
      console.log("=".repeat(60));
      return {};
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
        reply_to: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        tags: options.tags?.map((t) => ({ name: t })),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(
        `Resend API error: ${response.status} - ${error.message || "Unknown error"}`,
      );
    }

    const data = await response.json() as { id?: string };
    console.log(`[Email] Sent to ${options.to}`);

    return { messageId: data.id };
  }
}

// ---------------------------------------------------------------------------
// Register with the universal registry
// ---------------------------------------------------------------------------

registerProvider(
  {
    id: "resend",
    name: "Resend",
    type: "email",
    version: "1.0.0",
    settingsSchema: resendSettingsSchema,
    description: "Send transactional emails via the Resend API. Simple, developer-friendly email delivery.",
  },
  (settings) => new ResendEmailProvider(settings),
);
