import { ServiceUnavailableError } from "@scalius/core/errors";
import { senderMailbox, type EmailProvider, type EmailRuntimeContext, type SendEmailOptions, type SendEmailResult } from "./provider";
import { getEmailRuntimeSettings } from "./settings";

export class MailpitEmailProvider implements EmailProvider {
  readonly name = "mailpit";

  async sendEmail(
    { to, subject, html, from, fromName, text }: SendEmailOptions,
    context?: EmailRuntimeContext,
  ): Promise<SendEmailResult> {
    const settings = await getEmailRuntimeSettings(context);
    const baseUrl = settings.localMailpitUrl;
    if (!baseUrl) {
      throw new ServiceUnavailableError("Local Mailpit URL is not configured");
    }

    const sender = senderMailbox({ from, fromName }, settings);
    const response = await fetch(`${baseUrl}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: { Email: sender.email, ...(sender.name ? { Name: sender.name } : {}) },
        To: [{ Email: to }],
        Subject: subject,
        HTML: html,
        Text: text || "",
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
      provider: "mailpit",
      providerRef,
      rawStatus: "captured",
    };
  }
}
