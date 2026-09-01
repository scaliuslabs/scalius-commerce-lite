import { ServiceUnavailableError } from "@scalius/core/errors";
import type { EmailProvider, EmailRuntimeContext, SendEmailOptions, SendEmailResult } from "./provider";
import { getEmailRuntimeSettings } from "./settings";

export class MailpitEmailProvider implements EmailProvider {
  readonly name = "mailpit";

  async sendEmail(
    { to, subject, html, from, text }: SendEmailOptions,
    context?: EmailRuntimeContext,
  ): Promise<SendEmailResult> {
    const settings = await getEmailRuntimeSettings(context);
    const baseUrl = settings.localMailpitUrl;
    if (!baseUrl) {
      throw new ServiceUnavailableError("Local Mailpit URL is not configured");
    }

    const response = await fetch(`${baseUrl}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: { Email: from || settings.sender },
        To: [{ Email: to }],
        Subject: subject,
        HTML: html,
        Text: text || "",
      }),
    });
    if (!response.ok) {
      throw new ServiceUnavailableError(`Mailpit API error: ${response.status}`);
    }

    const data = await response.json<{ ID?: string }>();
    console.log("[Email] Captured locally in Mailpit");
    return {
      success: true,
      provider: "mailpit",
      providerRef: data.ID,
      rawStatus: "captured",
    };
  }
}
