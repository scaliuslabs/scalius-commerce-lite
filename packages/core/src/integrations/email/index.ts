// src/integrations/email/index.ts
// `sendEmail`: one message through the email port. The sender is the
// merchant's choice (the `email` document), read per send: a built-in one
// with the store's settings, or an app provider through the context's
// AppProviders, asked only when the choice names an app. While the chosen
// sender cannot send (not configured, the app not ready), the other built-in
// one takes the message when it can; with none, nothing is delivered and the
// result says so. Local development captures everything in Mailpit.

import { bindProvider, isAppProviderId, resolveAppProvider } from "../provider-port";
import { cloudflareEmail } from "./cloudflare";
import { mailpitEmail } from "./mailpit";
import {
  maskEmailForLog,
  resolveSender,
  safeEmailHeaders,
  type BuiltInEmailProviderId,
  type EmailAdapter,
  type EmailProvider,
  type EmailRuntimeContext,
  type EmailRuntimeSettings,
  type SendEmailOptions,
  type SendEmailResult,
} from "./provider";
import { resendEmail } from "./resend";
import { getEmailRuntimeSettings } from "./settings";

export type {
  BuiltInEmailProviderId,
  CloudflareEmailBinding,
  EmailAdapter,
  EmailAdapterSettings,
  EmailProvider,
  EmailRuntimeContext,
  EmailRuntimeSettings,
  SendEmailOptions,
  SendEmailResult,
} from "./provider";
export { BUILT_IN_EMAIL_PROVIDER_IDS } from "./provider";
export { cloudflareEmail } from "./cloudflare";
export { mailpitEmail } from "./mailpit";
export { resendEmail } from "./resend";
export { getEmailProviderReadiness, getEmailRuntimeSettings, isEmailProviderChoice } from "./settings";
export type { EmailProviderReadiness } from "./settings";

const BUILT_IN_EMAIL_ADAPTERS: Record<BuiltInEmailProviderId, EmailAdapter> = {
  cloudflare: cloudflareEmail,
  resend: resendEmail,
};

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

/** The senders a message may go through, in order: the merchant's choice, then the other built-in one. */
function providerOrder(settings: EmailRuntimeSettings): string[] {
  if (isAppProviderId(settings.provider)) return [settings.provider, "cloudflare", "resend"];
  return settings.provider === "resend"
    ? ["resend", "cloudflare"]
    : ["cloudflare", "resend"];
}

/** The first sender in order that can send now, or null. */
async function resolveEmailProvider(
  settings: EmailRuntimeSettings,
  context: EmailRuntimeContext | undefined,
): Promise<EmailProvider | null> {
  const adapterSettings = { runtime: settings, binding: context?.env?.EMAIL };
  if (settings.localMailpitUrl) return bindProvider("email", mailpitEmail, adapterSettings);
  for (const id of providerOrder(settings)) {
    if (isAppProviderId(id)) {
      const choice = await resolveAppProvider(context?.appProviders, "email", id);
      if (choice.provider) return choice.provider;
      continue;
    }
    const adapter = BUILT_IN_EMAIL_ADAPTERS[id as BuiltInEmailProviderId];
    if (adapter?.configured(adapterSettings)) return bindProvider("email", adapter, adapterSettings);
  }
  return null;
}

/**
 * Send an email through the merchant's sender (see the file comment). A
 * sender that cannot take the message throws or answers `success: false`.
 */
export async function sendEmail(
  options: SendEmailOptions,
  context?: EmailRuntimeContext,
): Promise<SendEmailResult> {
  const settings = await getEmailRuntimeSettings(context);
  const provider = await resolveEmailProvider(settings, context);
  if (!provider) return logEmailFallback(options, settings);

  // Every sender gets the store's sender address and name, resolved once.
  const sender = resolveSender(options, settings);
  const headers = safeEmailHeaders(options.headers);
  const result = await provider.send({
    to: options.to,
    subject: options.subject,
    html: options.html,
    ...(options.text !== undefined ? { text: options.text } : {}),
    from: sender.email,
    ...(sender.name ? { fromName: sender.name } : {}),
    ...(headers ? { headers } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  }, {});
  return { ...result, provider: provider.id };
}
