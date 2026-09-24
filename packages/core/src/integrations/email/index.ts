// src/integrations/email/index.ts
// Barrel file for email provider abstraction.

export type {
  SendEmailOptions,
  SendEmailResult,
  EmailProvider,
  EmailRuntimeContext,
  EmailRuntimeSettings,
  CloudflareEmailBinding,
} from "./provider";
export {
  registerEmailProvider,
  getEmailProvider,
} from "./provider";

export { CloudflareEmailProvider } from "./cloudflare";
export { MailpitEmailProvider } from "./mailpit";
export { ResendEmailProvider } from "./resend";
export { getEmailProviderReadiness, getEmailRuntimeSettings } from "./settings";
export type { EmailProviderReadiness } from "./settings";

// ── Register built-in providers ─────────────────────────────────────

import { registerEmailProvider } from "./provider";
import { CloudflareEmailProvider } from "./cloudflare";
import { MailpitEmailProvider } from "./mailpit";
import { ResendEmailProvider } from "./resend";

registerEmailProvider("cloudflare", new CloudflareEmailProvider());
registerEmailProvider("mailpit", new MailpitEmailProvider());
registerEmailProvider("resend", new ResendEmailProvider());

// ── Convenience functions (preserve existing public API) ────────────

import type { EmailRuntimeContext, EmailRuntimeSettings, SendEmailOptions, SendEmailResult } from "./provider";
import { getEmailProvider } from "./provider";
import { getEmailRuntimeSettings } from "./settings";

function maskEmailForLog(value: string | undefined): string {
  if (!value) return "unset";
  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) return "redacted";
  const visible = localPart.length <= 2
    ? localPart[0] ?? "*"
    : `${localPart[0]}${localPart[localPart.length - 1]}`;
  return `${visible}***@${domain}`;
}

function logEmailFallback(
  { to, subject, html, from, text }: SendEmailOptions,
  settings: EmailRuntimeSettings,
): SendEmailResult {
  const fromAddress = from || settings.sender;
  console.warn("[Email] No configured provider available; email was not delivered", {
    providerPreference: settings.provider,
    from: maskEmailForLog(fromAddress),
    to: maskEmailForLog(to),
    subjectLength: subject.length,
    htmlLength: html.length,
    textLength: text?.length ?? 0,
    contentLogged: false,
  });
  return {
    success: false,
    provider: "log",
    rawStatus: "No configured email provider available; email not delivered",
  };
}

function providerOrder(settings: EmailRuntimeSettings): Array<EmailRuntimeSettings["provider"]> {
  return settings.provider === "resend"
    ? ["resend", "cloudflare"]
    : ["cloudflare", "resend"];
}

function isProviderConfigured(
  providerName: EmailRuntimeSettings["provider"],
  settings: EmailRuntimeSettings,
  context?: EmailRuntimeContext,
): boolean {
  if (providerName === "cloudflare") return Boolean(context?.env?.EMAIL);
  return Boolean(settings.resendApiKey);
}

/**
 * Send an email using the configured provider.
 * Falls back to the secondary provider, then console logging, when unavailable.
 */
export async function sendEmail(
  options: SendEmailOptions,
  context?: EmailRuntimeContext,
): Promise<SendEmailResult> {
  const settings = await getEmailRuntimeSettings(context);
  const runtimeContext: EmailRuntimeContext = { ...context, settings };

  if (settings.localMailpitUrl) {
    return getEmailProvider("mailpit")!.sendEmail(options, runtimeContext);
  }

  for (const providerName of providerOrder(settings)) {
    if (!isProviderConfigured(providerName, settings, runtimeContext)) continue;
    const provider = getEmailProvider(providerName);
    if (!provider) continue;
    return await provider.sendEmail(options, runtimeContext);
  }

  return logEmailFallback(options, settings);
}
