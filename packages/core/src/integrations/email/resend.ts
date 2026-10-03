// src/integrations/email/resend.ts
// Resend behind the email port.

import { ServiceUnavailableError } from "@scalius/core/errors";
import { maskEmailForLog, resolveSender, safeEmailHeaders, type EmailAdapter } from "./provider";

export const resendEmail: EmailAdapter = {
  id: "resend",
  label: "Resend",

  configured: ({ runtime }) => Boolean(runtime.resendApiKey),

  async send({ to, subject, html, from, fromName, text, idempotencyKey, headers }, { settings: { runtime } }) {
    const apiKey = runtime.resendApiKey;
    if (!apiKey) {
      throw new ServiceUnavailableError("Resend API key is not configured");
    }

    const sender = resolveSender({ from, fromName }, runtime);
    const fromAddress = sender.name ? `"${sender.name}" <${sender.email}>` : sender.email;
    const extraHeaders = safeEmailHeaders(headers);

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
          ...(extraHeaders ? { headers: extraHeaders } : {}),
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
        providerRef: data.id,
        rawStatus: "accepted",
      };
    } catch (error: unknown) {
      console.error("[Email] Failed to send via Resend:", error);
      throw new ServiceUnavailableError(
        `Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};
