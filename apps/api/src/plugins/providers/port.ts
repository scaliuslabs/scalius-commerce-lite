// An app provider of a port whose operations core calls as they are
// (translation, AI, messaging, push, search, address, FX, identity): each
// declared operation runs through the plugin host, which validates both
// sides of the port. A failure is the port's `ProviderError`; each consumer
// decides what it means (an editor shows it, search falls back to built-in
// search, an FX refresh keeps the last rate, sign-in fails closed).

import type { BoundProvider } from "@scalius/core/integrations/provider-port";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import {
  customChannelId,
  declaredProviderOperations,
  qualifiedProviderId,
  type PluginProviderDeclaration,
  type ProviderKind,
} from "@scalius/shared/plugins/providers";
import { withSignal, type AppProviderRuntime } from "./runtime";

/** One app provider as its port: exactly the required and the declared operations. */
export function appPortProvider<K extends ProviderKind>(kind: K) {
  return (runtime: AppProviderRuntime, installation: PluginInstallation, declaration: PluginProviderDeclaration): BoundProvider<K> => {
    const provider: Record<string, unknown> = {
      id: qualifiedProviderId(installation.pluginId, declaration.id),
      label: declaration.name,
    };
    if ("countries" in declaration) provider.countries = declaration.countries;
    // A messaging provider carries its built-in channels and its app's own (`<app id>:<key>`).
    if ("channels" in declaration) {
      provider.channels = [
        ...declaration.channels,
        ...("customChannels" in declaration ? declaration.customChannels ?? [] : []).map((channel) => customChannelId(installation.pluginId, channel.key)),
      ];
    }
    if ("dedupesOnIdempotencyKey" in declaration && declaration.dedupesOnIdempotencyKey === true) provider.dedupesOnIdempotencyKey = true;
    for (const operation of declaredProviderOperations(declaration)) {
      provider[operation] = async (input: unknown, { signal }: { signal?: AbortSignal } = {}) => {
        const host = await runtime.host();
        return withSignal(host.invokeProvider(installation, kind, declaration.id, operation as never, input as never), signal);
      };
    }
    return provider as BoundProvider<K>;
  };
}
