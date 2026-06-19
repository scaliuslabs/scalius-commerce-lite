// src/integrations/email/cloudflare.ts
// Cloudflare Email Service provider using the Workers send_email binding.

import { ServiceUnavailableError } from "@scalius/core/errors";
import type { EmailProvider, EmailRuntimeContext, SendEmailOptions, SendEmailResult } from "./provider";
import { getEmailRuntimeSettings } from "./settings";

export class CloudflareEmailProvider implements EmailProvider {
  readonly name = "cloudflare";

  async sendEmail(
    { to, subject, html, from, text }: SendEmailOptions,
    context?: EmailRuntimeContext,
  ): Promise<SendEmailResult> {
    const binding = context?.env?.EMAIL;
    if (!binding) {
      throw new ServiceUnavailableError("Cloudflare Email binding EMAIL is not configured");
    }

    const settings = await getEmailRuntimeSettings(context);
    const fromAddress = from || settings.sender;
    const result = await binding.send({
      to,
      from: fromAddress,
      subject,
      html,
      text,
    });

    console.log(`[Email] Sent via Cloudflare to ${to} (${result.messageId})`);
    return {
      success: true,
      provider: "cloudflare",
      providerRef: result.messageId,
      rawStatus: "accepted",
    };
  }
}
