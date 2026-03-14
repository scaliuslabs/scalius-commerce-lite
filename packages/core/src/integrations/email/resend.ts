// src/integrations/email/resend.ts
// Resend email provider implementation.
// API key and sender address are loaded from the DB settings table.

import type { EmailProvider, SendEmailOptions } from "./provider";

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
  } catch (err) {
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
          throw new Error(
            error instanceof Error ? error.message : `Resend API error: ${response.status}`,
          );
        }

        console.log(`[Email] Sent to ${to}`);
      } catch (error) {
        console.error("[Email] Failed to send via Resend:", error);
        throw new Error(
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
