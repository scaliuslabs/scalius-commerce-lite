// src/integrations/email/mailpit.ts
// Local development only: every message is captured by a loopback Mailpit
// (LOCAL_MAILPIT_URL) instead of reaching a real sender.

import { ServiceUnavailableError } from "@scalius/core/errors";
import { resolveSender, safeEmailHeaders, type EmailAdapter } from "./provider";

export const mailpitEmail: EmailAdapter = {
  id: "mailpit",
  label: "Mailpit",

  configured: ({ runtime }) => Boolean(runtime.localMailpitUrl),

  async send({ to, subject, html, from, fromName, text, headers }, { settings: { runtime } }) {
    const baseUrl = runtime.localMailpitUrl;
    if (!baseUrl) {
      throw new ServiceUnavailableError("Local Mailpit URL is not configured");
    }

    const sender = resolveSender({ from, fromName }, runtime);
    const extraHeaders = safeEmailHeaders(headers);
    const response = await fetch(`${baseUrl}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: sender.name ? { Email: sender.email, Name: sender.name } : { Email: sender.email },
        To: [{ Email: to }],
        Subject: subject,
        HTML: html,
        Text: text || "",
        ...(extraHeaders ? { Headers: extraHeaders } : {}),
      }),
    });
    if (!response.ok) {
      throw new ServiceUnavailableError(`Mailpit API error: ${response.status}`);
    }

    const data: unknown = await response.json();
    const providerRef = typeof data === "object" && data !== null
      && "ID" in data && typeof data.ID === "string"
      ? data.ID
      : undefined;
    console.log("[Email] Captured locally in Mailpit");
    return {
      success: true,
      providerRef,
      rawStatus: "captured",
    };
  },
};
