// App AI providers as the AI port (`generate`): structured generation
// against a JSON Schema. The platform has no built-in provider and no model
// key. The plugin host validates both sides of the port; each consumer (the
// theme editor's Draft with AI first) validates the value against its own
// schemas, and nothing is saved until the merchant saves it.

import type { BoundProvider } from "@scalius/core/integrations/provider-port";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  declaredProviderOperations,
  qualifiedProviderId,
  type PluginProviderDeclaration,
  type ProviderOperation,
} from "@scalius/shared/plugins/providers";
import { withSignal, type AppProviderRuntime } from "./runtime";

/** One app AI provider as the AI port. */
export function appAiProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): BoundProvider<"ai"> {
  const operations = new Set(declaredProviderOperations(declaration));
  const invoke = async (operation: ProviderOperation<"ai">, input: unknown, signal: AbortSignal | undefined): Promise<never> => {
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, "ai", declaration.id, operation, input as never), signal) as Promise<never>;
  };
  const provider: Record<string, unknown> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    generate: (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke("generate", input, signal),
  };
  if (operations.has("testConnection")) {
    provider.testConnection = (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke("testConnection", input, signal);
  }
  return provider as BoundProvider<"ai">;
}
