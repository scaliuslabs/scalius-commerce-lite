// src/integrations/email/resend.ts
// Resend email provider.
// @deprecated Use `packages/core/src/providers/email/resend-adapter.ts` (universal provider)
// which receives validated settings at construction time and integrates with
// the provider registry. This file is retained for backward compatibility with
// the email barrel (integrations/email/index.ts).

import type { EmailProvider, EmailRuntimeContext, SendEmailOptions } from "./provider";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { getEmailRuntimeSettings } from "./settings";

/**
 * Email provider that sends via the Resend API.
 * Falls back to console logging when the API key is not configured.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async sendEmail(
    { to, subject, html, from, text }: SendEmailOptions,
    context?: EmailRuntimeContext,
  ): Promise<void> {
    const settings = await getEmailRuntimeSettings(context);
    const apiKey = settings.resendApiKey;
    if (!apiKey) {
      throw new ServiceUnavailableError("Resend API key is not configured");
    }

    const fromAddress = from || settings.sender;

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          subject,
          html,
          text,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string };
        throw new ServiceUnavailableError(error.message || `Resend API error: ${response.status}`);
      }

      console.log(`[Email] Sent via Resend to ${to}`);
    } catch (error: unknown) {
      console.error("[Email] Failed to send via Resend:", error);
      throw new ServiceUnavailableError(
        `Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
