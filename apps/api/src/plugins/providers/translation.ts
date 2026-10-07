// App translation providers as the translation port (MARKETS-DESIGN D9): the
// translation editor's machine translation. The platform has no built-in
// provider. The plugin host validates both sides of the port; a failure is
// the editor's error, and nothing is saved until the merchant saves.

import type { BoundProvider } from "@scalius/core/integrations/provider-port";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  declaredProviderOperations,
  qualifiedProviderId,
  type PluginProviderDeclaration,
  type ProviderOperation,
} from "@scalius/shared/plugins/providers";
import { withSignal, type AppProviderRuntime } from "./runtime";

/** One app translation provider as the translation port. */
export function appTranslationProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): BoundProvider<"translation"> {
  const operations = new Set(declaredProviderOperations(declaration));
  const invoke = async (operation: ProviderOperation<"translation">, input: unknown, signal: AbortSignal | undefined): Promise<never> => {
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, "translation", declaration.id, operation, input as never), signal) as Promise<never>;
  };
  const provider: Record<string, unknown> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    translate: (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke("translate", input, signal),
  };
  if (operations.has("testConnection")) {
    provider.testConnection = (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke("testConnection", input, signal);
  }
  return provider as BoundProvider<"translation">;
}
