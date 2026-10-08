// The store's WhatsApp sender: the built-in Meta WhatsApp Cloud API, or an app
// messaging provider (`<plugin id>:<provider id>`) that carries the `whatsapp`
// channel, as the merchant saved it (`whatsappDocument.provider`, "" = built in).
//
// Order notifications, customer-login codes and every readiness check go
// through `resolveWhatsAppSender`, so they never ask which kind they got. A
// send always answers (never throws for a provider failure), so the
// notification and OTP queues keep their own retry rules for both kinds:
// - `retryable`: retried, unless the provider may already have sent it
//   (`uncertain`) and the message carries no `clientReference` it can dedupe on.
// - `misconfigured`: final, worded "not configured" so the provider is paused
//   until its settings are saved, like the built-in one.
// Statuses are sanitized (no phone numbers, addresses or tokens) before they
// reach a receipt or a log; an app's raw payloads never do.

import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { providerErrorOf } from "@scalius/shared/plugins/providers";
import type { Database } from "@scalius/database/client";
import { isAppProviderId, resolveAppProvider, type AppProviders } from "./provider-port";
import { sanitizeSmsProviderDiagnostic } from "./sms/retryability";
import {
  getWhatsAppCloudApiSettings,
  sendWhatsAppTemplateMessage,
  type SendWhatsAppTemplateMessageResult,
} from "./whatsapp";

/** The provider name of the built-in sender in receipts and provider blocks. */
export const BUILT_IN_WHATSAPP_PROVIDER = "whatsapp";

export const WHATSAPP_NOT_CONFIGURED_REASON =
  "Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.";

export interface WhatsAppTemplateSend {
  /** The buyer's phone (E.164 or a national number the platform can normalize). */
  to: string;
  templateName: string;
  languageCode?: string;
  /** The template body values in order. */
  bodyParameters?: string[];
  /** Deterministic per message; an app provider dedupes on it. */
  clientReference?: string;
}

export type WhatsAppSender =
  | {
    ready: true;
    /** `whatsapp` for the built-in sender, else the app provider id. */
    provider: string;
    /** The store's template for customer-login codes ("" when its name looks like a placeholder). */
    authTemplateName: string;
    sendTemplate(input: WhatsAppTemplateSend): Promise<SendWhatsAppTemplateMessageResult>;
  }
  | {
    ready: false;
    provider: string;
    /** Merchant-facing. */
    reason: string;
  };

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const MAX_TEMPLATE_PARAMETERS = 10;
const MAX_TEMPLATE_PARAMETER_LENGTH = 1024;

function sanitized(status: string): string {
  return sanitizeSmsProviderDiagnostic(status) ?? "provider_failure";
}

function appTemplateParameters(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .slice(0, MAX_TEMPLATE_PARAMETERS)
    .map((value) => value.slice(0, MAX_TEMPLATE_PARAMETER_LENGTH));
}

/**
 * The sender the store's WhatsApp settings name, and whether it can send now.
 * A paused provider is not checked here: callers key their provider block by
 * the returned `provider`.
 */
export async function resolveWhatsAppSender(
  db: Database,
  options: { encryptionKey?: string; appProviders?: AppProviders } = {},
): Promise<WhatsAppSender> {
  const config = await getWhatsAppCloudApiSettings(db, options.encryptionKey);
  const chosen = typeof config.provider === "string" ? config.provider.trim() : "";

  if (!chosen) {
    const { accessToken, phoneNumberId } = config;
    if (!accessToken || !phoneNumberId) {
      return { ready: false, provider: BUILT_IN_WHATSAPP_PROVIDER, reason: WHATSAPP_NOT_CONFIGURED_REASON };
    }
    return {
      ready: true,
      provider: BUILT_IN_WHATSAPP_PROVIDER,
      authTemplateName: config.authTemplateName,
      sendTemplate: (input) => sendWhatsAppTemplateMessage({
        accessToken,
        phoneNumberId,
        to: input.to,
        templateName: input.templateName,
        languageCode: input.languageCode,
        bodyParameters: input.bodyParameters,
      }),
    };
  }

  if (!isAppProviderId(chosen)) {
    return { ready: false, provider: chosen, reason: "The WhatsApp provider you chose is not an installed app. Choose another provider." };
  }
  const choice = await resolveAppProvider(options.appProviders, "messaging", chosen);
  if (!choice.provider) return { ready: false, provider: chosen, reason: choice.issue };
  const provider = choice.provider;
  if (!provider.channels?.includes("whatsapp")) {
    return { ready: false, provider: chosen, reason: `${provider.label} does not send on WhatsApp. Choose another WhatsApp provider.` };
  }

  return {
    ready: true,
    provider: chosen,
    authTemplateName: config.authTemplateName,
    async sendTemplate(input): Promise<SendWhatsAppTemplateMessageResult> {
      const templateName = input.templateName.trim();
      const language = input.languageCode?.trim() || "en_US";
      if (!TEMPLATE_NAME.test(templateName) || !TEMPLATE_LANGUAGE.test(language)) {
        return { success: false, rawStatus: "invalid_whatsapp_template", retryable: false };
      }
      const idempotent = input.clientReference !== undefined;
      try {
        const answer = await provider.send({
          channel: "whatsapp",
          to: validateAndFormatPhone(input.to),
          template: { name: templateName, language, parameters: appTemplateParameters(input.bodyParameters) },
          ...(idempotent ? { clientReference: input.clientReference } : {}),
        }, {});
        return {
          success: answer.success,
          ...(answer.providerRef ? { providerRef: answer.providerRef } : {}),
          rawStatus: answer.rawStatus === undefined
            ? (answer.success ? "accepted" : "failed")
            : sanitized(answer.rawStatus),
          ...(answer.retryable === undefined ? {} : { retryable: answer.retryable }),
        };
      } catch (error) {
        const failure = providerErrorOf(error);
        if (!failure) throw error;
        if (failure.category === "misconfigured") {
          return { success: false, rawStatus: sanitized(`${provider.label} is not configured: ${failure.message}`), retryable: false };
        }
        return {
          success: false,
          rawStatus: sanitized(failure.message),
          retryable: failure.category === "retryable" && (!failure.uncertain || idempotent),
        };
      }
    },
  };
}
