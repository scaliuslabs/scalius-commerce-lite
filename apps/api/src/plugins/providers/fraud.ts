// App fraud checkers as the fraud port the merchant's order-page lookup
// calls (`@scalius/core/modules/fraud-checker`). The lookup is advice for the
// merchant, never automatic blocking. Each operation runs through the plugin
// host, which validates both sides of the port; the port's ProviderError
// reaches the lookup, which shows its merchant-safe message.

import type { FraudProvider } from "@scalius/core/modules/fraud-checker";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  ProviderError,
  declaredProviderOperations,
  qualifiedProviderId,
  type FraudCheckInput,
  type PluginProviderDeclaration,
} from "@scalius/shared/plugins/providers";
import { compactPhone, normalizeBdMobile } from "@scalius/shared/phone-input";
import { withSignal, type AppProviderRuntime } from "./runtime";

const E164 = /^\+[1-9]\d{6,14}$/;

/** The port takes E.164; the dashboard sends what the merchant typed or the order kept. */
function e164(phone: string): string {
  const compact = compactPhone(phone);
  const normalized = E164.test(compact) ? compact : normalizeBdMobile(compact);
  if (!normalized) throw new ProviderError("declined", "Enter the customer's phone number with its country code.", { code: "fraud.phone_invalid" });
  return normalized;
}

/** One app fraud checker as the fraud port. */
export function appFraudProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): FraudProvider {
  const operations = new Set(declaredProviderOperations(declaration));
  const invoke = async (operation: "check" | "testConnection", input: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, "fraud", declaration.id, operation, input as never), signal);
  };
  const provider: FraudProvider = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    countries: declaration.kind === "fraud" ? declaration.countries : "any",
    check: async (input: FraudCheckInput, { signal } = {}) =>
      invoke("check", { ...input, phone: e164(input.phone) }, signal) as ReturnType<FraudProvider["check"]>,
  };
  if (operations.has("testConnection")) {
    provider.testConnection = (input, { signal } = {}) =>
      invoke("testConnection", input, signal) as ReturnType<NonNullable<FraudProvider["testConnection"]>>;
  }
  return provider;
}
