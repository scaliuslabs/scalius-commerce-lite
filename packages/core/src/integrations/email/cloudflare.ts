// src/integrations/email/cloudflare.ts
// Cloudflare Email Service behind the email port, through the Workers
// send_email binding.

import { ServiceUnavailableError } from "@scalius/core/errors";
import { maskEmailForLog, resolveSender, safeEmailHeaders, type EmailAdapter } from "./provider";

/** Binding errors after which the message may already be on its way. */
const UNCONFIRMED_SEND_CODES = new Set(["E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED"]);

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
    let result: { messageId: string };
    try {
      result = await binding.send({
        to,
        from: sender.name ? sender : sender.email,
        subject,
        html,
        text,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
    } catch (error: unknown) {
      // The binding takes no idempotency key. A refusal with its own code
      // (validation, limits, an unverified address) proves nothing was sent
      // and is thrown as before; an internal error, a failed hand-off or an
      // error without a code may follow a message that went, so it is final.
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.startsWith("E_") && !UNCONFIRMED_SEND_CODES.has(code)) throw error;
      console.error(`[Email] Cloudflare send not confirmed (${typeof code === "string" ? code : "no code"})`);
      return { success: false, rawStatus: "cloudflare_send_unconfirmed", retryable: false };
    }

    console.log(`[Email] Sent via Cloudflare to ${maskEmailForLog(to)} (${result.messageId})`);
    return {
      success: true,
      providerRef: result.messageId,
      rawStatus: "accepted",
    };
  },
};
