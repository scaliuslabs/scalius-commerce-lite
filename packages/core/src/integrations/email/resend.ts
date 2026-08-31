// src/integrations/email/resend.ts
// Resend email provider.
// Active Resend implementation selected by the email integration registry.

import type { EmailProvider, EmailRuntimeContext, SendEmailOptions, SendEmailResult } from "./provider";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { getEmailRuntimeSettings } from "./settings";

function maskEmailForLog(value: string): string {
  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) return "redacted";
  const visible = localPart.length <= 2
    ? localPart[0] ?? "*"
    : `${localPart[0]}${localPart[localPart.length - 1]}`;
  return `${visible}***@${domain}`;
}

/**
 * Email provider that sends via the Resend API.
 * Falls back to console logging when the API key is not configured.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async sendEmail(
    { to, subject, html, from, text, idempotencyKey }: SendEmailOptions,
    context?: EmailRuntimeContext,
  ): Promise<SendEmailResult> {
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
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {}),
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
        const message = error.message?.replace(/\s+/g, " ").trim();
        throw new ServiceUnavailableError(
          `Resend API error: ${response.status}${message ? `: ${message}` : ""}`,
        );
      }

      const data = await response.json().catch(() => ({})) as { id?: string };
      console.log(`[Email] Sent via Resend to ${maskEmailForLog(to)}${data.id ? ` (${data.id})` : ""}`);
      return {
        success: true,
        provider: "resend",
        providerRef: data.id,
        rawStatus: "accepted",
      };
    } catch (error: unknown) {
      console.error("[Email] Failed to send via Resend:", error);
      throw new ServiceUnavailableError(
        `Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
