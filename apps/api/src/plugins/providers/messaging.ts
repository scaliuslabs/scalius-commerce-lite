// App SMS and email providers as the ports core sends through
// (`@scalius/core/integrations/{sms,email}`). Each operation the app declares
// runs through the plugin host (bundled on Workers Free, the sandbox on
// Workers Paid), which validates both sides of the port.
//
// A send always answers, so the notification and OTP queues keep their own
// retry rules for every provider alike:
// - `retryable`: retried, unless the provider may already have sent it
//   (`uncertain`) and the message carries no idempotency key the app can
//   dedupe on; then it is never sent twice.
// - `declined`: final for this message.
// - `misconfigured`: final, worded "not configured" so the provider is
//   paused until its settings are saved, like a built-in one.
// Statuses are sanitized (no phone numbers, addresses or tokens) before they
// reach a receipt or a log; the app's raw payloads never do.

import type { EmailProvider } from "@scalius/core/integrations/email";
import type { SmsProvider } from "@scalius/core/integrations/sms";
import { sanitizeSmsProviderDiagnostic } from "@scalius/core/integrations/sms/retryability";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  PROVIDER_PORTS,
  declaredProviderOperations,
  providerErrorOf,
  qualifiedProviderId,
  type PluginProviderDeclaration,
} from "@scalius/shared/plugins/providers";
import { withSignal, type AppProviderRuntime } from "./runtime";

type MessagingKind = "sms" | "email";
type SendAnswer = { success: boolean; providerRef?: string; rawStatus?: string; retryable?: boolean };
type Call = { signal?: AbortSignal };

function sanitized(status: string): string {
  return sanitizeSmsProviderDiagnostic(status) ?? "provider_failure";
}

/** A send the app could not complete, as the port's answer (see the file comment). */
function failedSend(error: unknown, label: string, idempotent: boolean): SendAnswer {
  const failure = providerErrorOf(error);
  if (!failure) throw error;
  if (failure.category === "misconfigured") {
    return { success: false, rawStatus: sanitized(`${label} is not configured: ${failure.message}`), retryable: false };
  }
  return {
    success: false,
    rawStatus: sanitized(failure.message),
    retryable: failure.category === "retryable" && (!failure.uncertain || idempotent),
  };
}

function appMessagingProvider(
  kind: MessagingKind,
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): Record<string, unknown> {
  const operations = new Set(declaredProviderOperations(declaration));
  const invoke = async (operation: "send" | "deliveryStatus" | "testConnection", input: unknown, call: Call = {}): Promise<unknown> => {
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, kind, declaration.id, operation, input as never), call.signal);
  };

  const provider: Record<string, unknown> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    async send(input: Record<string, unknown>, call: Call = {}): Promise<SendAnswer> {
      // A message that does not fit the port can never pass: refuse it before the app runs.
      if (!PROVIDER_PORTS[kind].send.input.safeParse(input).success) {
        return { success: false, rawStatus: `The message does not fit the ${kind} provider port.`, retryable: false };
      }
      try {
        const answer = await invoke("send", input, call) as SendAnswer;
        return answer.rawStatus === undefined ? answer : { ...answer, rawStatus: sanitized(answer.rawStatus) };
      } catch (error) {
        return failedSend(error, declaration.name, typeof input.idempotencyKey === "string");
      }
    },
  };
  if (operations.has("deliveryStatus")) provider.deliveryStatus = (input: unknown, call?: Call) => invoke("deliveryStatus", input, call);
  if (operations.has("testConnection")) provider.testConnection = (input: unknown, call?: Call) => invoke("testConnection", input, call);
  return provider;
}

/** One app SMS provider as the SMS port; the platform's message reference is its `idempotencyKey`. */
export function appSmsProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): SmsProvider {
  return appMessagingProvider("sms", runtime, installation, declaration) as unknown as SmsProvider;
}

/** One app email provider as the email port; the platform's delivery key is its idempotency key. */
export function appEmailProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): EmailProvider {
  return appMessagingProvider("email", runtime, installation, declaration) as unknown as EmailProvider;
}
