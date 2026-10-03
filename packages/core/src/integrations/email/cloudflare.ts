// src/integrations/email/cloudflare.ts
// Cloudflare Email Service behind the email port, through the Workers
// send_email binding.

import { ServiceUnavailableError } from "@scalius/core/errors";
import { maskEmailForLog, resolveSender, safeEmailHeaders, type EmailAdapter } from "./provider";

export const cloudflareEmail: EmailAdapter = {
  id: "cloudflare",
  label: "Cloudflare Email",

  configured: ({ binding }) => Boolean(binding),

  async send({ to, subject, html, from, fromName, text, headers }, { settings: { runtime, binding } }) {
    if (!binding) {
      throw new ServiceUnavailableError("Cloudflare Email binding EMAIL is not configured");
    }

    const sender = resolveSender({ from, fromName }, runtime);
    const extraHeaders = safeEmailHeaders(headers);
    const result = await binding.send({
      to,
      from: sender.name ? sender : sender.email,
      subject,
      html,
      text,
      ...(extraHeaders ? { headers: extraHeaders } : {}),
    });

    console.log(`[Email] Sent via Cloudflare to ${maskEmailForLog(to)} (${result.messageId})`);
    return {
      success: true,
      providerRef: result.messageId,
      rawStatus: "accepted",
    };
  },
};
