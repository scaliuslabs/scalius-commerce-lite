// Which registries the store browses and which developer keys it trusts
// (docs/platform/PLUGINS.md, "Registry"). One settings document,
// `plugin_registry`: the operator's own registries (index URLs) and the
// public keys a Super Admin chose to trust. The official registry and its key
// are pinned in code (`OFFICIAL_PLUGIN_REGISTRY`) and are empty until the
// owner publishes them; an empty list trusts nothing.

import { z } from "zod";
import {
  OFFICIAL_PLUGIN_REGISTRY,
  pluginTrustedKeySchema,
  type PluginTrustedKey,
} from "@scalius/shared/plugins/registry";
import { defineSettingsDocument } from "../../settings-store";

export const PLUGIN_REGISTRIES_MAX = 10;
export const PLUGIN_TRUSTED_KEYS_MAX = 50;

const registryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Use lowercase letters, digits and hyphens.")
  .refine((id) => id !== OFFICIAL_PLUGIN_REGISTRY.id, "This id is reserved for the official registry.");

export const pluginRegistrySourceSchema = z.object({
  id: registryIdSchema,
  name: z.string().trim().min(1).max(80),
  /** The HTTPS address of the registry's index.json. */
  indexUrl: z.string().url().max(500).refine((url) => url.startsWith("https://"), "Use an https:// address."),
}).strict();
export type PluginRegistrySource = z.infer<typeof pluginRegistrySourceSchema>;

export interface PluginRegistrySettings {
  registries: PluginRegistrySource[];
  trustedKeys: PluginTrustedKey[];
}

export const pluginRegistrySettingsSchema = z.object({
  registries: z.array(pluginRegistrySourceSchema).max(PLUGIN_REGISTRIES_MAX)
    .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, "Registry ids must be unique."),
  trustedKeys: z.array(pluginTrustedKeySchema).max(PLUGIN_TRUSTED_KEYS_MAX)
    .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, "Each key is trusted once."),
}).strict();

export const pluginRegistrySettingsDocument = defineSettingsDocument<PluginRegistrySettings>({
  key: "plugin_registry",
  schema: pluginRegistrySettingsSchema,
  defaults: { registries: [], trustedKeys: [] },
});

/** Every registry the store browses: the official one when it is configured, then the operator's. */
export function pluginRegistrySources(settings: PluginRegistrySettings): Array<PluginRegistrySource & { official: boolean }> {
  const official = OFFICIAL_PLUGIN_REGISTRY.indexUrl
    ? [{ id: OFFICIAL_PLUGIN_REGISTRY.id, name: OFFICIAL_PLUGIN_REGISTRY.name, indexUrl: OFFICIAL_PLUGIN_REGISTRY.indexUrl, official: true }]
    : [];
  return [...official, ...settings.registries.map((registry) => ({ ...registry, official: false }))];
}

/** Every key a signature may verify against: the official keys, then the ones a Super Admin trusted. */
export function trustedPluginKeys(settings: PluginRegistrySettings): PluginTrustedKey[] {
  const official = OFFICIAL_PLUGIN_REGISTRY.keys.map((key) => ({ ...key }));
  const ids = new Set(official.map((key) => key.id));
  return [...official, ...settings.trustedKeys.filter((key) => !ids.has(key.id))];
}

/** Whether a key is one of the official keys pinned in code. */
export function isOfficialPluginKey(keyId: string): boolean {
  return OFFICIAL_PLUGIN_REGISTRY.keys.some((key) => key.id === keyId);
}
