// App tax providers as the tax port checkout calls (`@scalius/core/modules/tax`,
// `quoteTax`): the same port as the built-in system provider. Each operation
// the app declares runs through the plugin host (bundled on Workers Free, the
// sandbox on Workers Paid), which validates both sides of the port. Core
// fails closed on any failure: checkout refuses rather than charging no tax.

import type { BoundProvider } from "@scalius/core/integrations/provider-port";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  declaredProviderOperations,
  qualifiedProviderId,
  type PluginProviderDeclaration,
  type ProviderOperation,
} from "@scalius/shared/plugins/providers";
import { withSignal, type AppProviderRuntime } from "./runtime";

/** One app tax provider as the tax port. */
export function appTaxProvider(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PluginProviderDeclaration,
): BoundProvider<"tax"> {
  const operations = new Set(declaredProviderOperations(declaration));
  const invoke = async (operation: ProviderOperation<"tax">, input: unknown, signal: AbortSignal | undefined): Promise<never> => {
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, "tax", declaration.id, operation, input as never), signal) as Promise<never>;
  };
  const provider: Record<string, unknown> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    calculate: (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke("calculate", input, signal),
  };
  for (const operation of ["commit", "void", "refund", "testConnection"] as const) {
    if (operations.has(operation)) {
      provider[operation] = (input: unknown, { signal }: { signal?: AbortSignal } = {}) => invoke(operation, input, signal);
    }
  }
  return provider as BoundProvider<"tax">;
}
