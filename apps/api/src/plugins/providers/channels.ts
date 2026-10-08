// A saved chat-channel choice (the WhatsApp provider) must name an installed
// app's messaging provider that carries that channel. Readiness (active,
// approved, configured) is checked where the provider is used, so a merchant
// may choose an app before finishing its setup.

import type { Database } from "@scalius/database/client";
import { getPluginInstallation } from "@scalius/core/modules/plugins";
import { parseQualifiedProviderId, type MessagingChannel } from "@scalius/shared/plugins/providers";
import { ValidationError } from "../../utils/api-error";
import { assertAppProviderInstalled } from "./app-providers";

export async function assertMessagingProviderCarries(db: Database, id: string, channel: MessagingChannel): Promise<void> {
  await assertAppProviderInstalled(db, "messaging", id);
  const parsed = parseQualifiedProviderId(id);
  const installation = parsed ? await getPluginInstallation(db, parsed.pluginId) : null;
  const declaration = installation?.manifest.providers.find((provider) => provider.kind === "messaging" && provider.id === parsed?.providerId);
  const channels: readonly string[] = declaration && "channels" in declaration ? declaration.channels : [];
  if (!channels.includes(channel)) {
    throw new ValidationError(`This app does not send on ${channel === "whatsapp" ? "WhatsApp" : channel}. Choose a provider that does.`);
  }
}
