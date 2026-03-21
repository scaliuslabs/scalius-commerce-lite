// src/integrations/email/resend.ts
// LEGACY Resend email provider — reads settings from DB on every send.
// @deprecated Use `packages/core/src/providers/email/resend-adapter.ts` (universal provider)
// which receives validated settings at construction time and integrates with
// the provider registry. This file is retained for backward compatibility with
// the email barrel (integrations/email/index.ts).

import type { EmailProvider, SendEmailOptions } from "./provider";
import { ServiceUnavailableError } from "@scalius/core/errors";

const DEFAULT_FROM = "noreply@example.com";

/**
 * Fetch Resend settings (api key + sender) from the DB settings table.
 * Returns null values when the settings are not configured.
 */
async function getEmailSettings(): Promise<{
  apiKey: string | null;
  sender: string;
}> {
  try {
    // Dynamic import to avoid circular deps and allow tree-shaking
    const { getDb } = await import("@scalius/database/client");
    const { settings } = await import("@scalius/database/schema");
    const { and, eq } = await import("drizzle-orm");

    const db = getDb();

    const [apiKeyRow, senderRow] = await Promise.all([
      db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email")))
        .get(),
      db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, "email_sender"), eq(settings.category, "email")))
        .get(),
    ]);

    return {
      apiKey: apiKeyRow?.value || null,
      sender: senderRow?.value || DEFAULT_FROM,
    };
  } catch (err: unknown) {
    console.error("[Email] Failed to load email settings from DB:", err);
    return { apiKey: null, sender: DEFAULT_FROM };
  }
}

/**
 * Email provider that sends via the Resend API.
 * Falls back to console logging when the API key is not configured.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async sendEmail({ to, subject, html, from, text }: SendEmailOptions): Promise<void> {
    const { apiKey, sender } = await getEmailSettings();
    const fromAddress = from || sender;

    if (apiKey) {
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
          const error = await response.json().catch(() => ({}));
          throw new ServiceUnavailableError(
            error instanceof Error ? error.message : `Resend API error: ${response.status}`,
          );
        }

        console.log(`[Email] Sent to ${to}`);
      } catch (error: unknown) {
        console.error("[Email] Failed to send via Resend:", error);
        throw new ServiceUnavailableError(
          `Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    } else {
      // Development fallback - log to console
      console.log("=".repeat(60));
      console.log("EMAIL (Resend API key not configured - logging only)");
      console.log("=".repeat(60));
      console.log(`From: ${fromAddress}`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log("-".repeat(60));
      console.log(html);
      if (text) {
        console.log("-".repeat(60));
        console.log(text);
      }
      console.log("=".repeat(60));
    }
  }
}
