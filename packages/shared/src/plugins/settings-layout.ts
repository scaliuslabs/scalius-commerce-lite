// Where an app's settings show in the dashboard (docs/platform/PLUGINS.md,
// "App surfaces"). A provider's fields show with the provider where the
// merchant sets it up (Settings → Notifications for an SMS gateway, Shipping
// for a courier), never on one flat page; the app's page shows only its
// app-wide fields, in the sections the manifest declares. Presentation only:
// storage, validation and readiness never read it. Pure; no zod.

/** The manifest parts the layout reads (a parsed manifest fits). */
export interface PluginSettingsLayoutSource {
  settings: ReadonlyArray<{ key: string; group?: string | undefined }>;
  /** The settings page's sections (`admin.settingsGroups`). */
  admin: { settingsGroups: ReadonlyArray<{ id: string; title: string; description?: string | undefined; order: number }> };
  providers: ReadonlyArray<{ id: string; settings?: readonly string[] | undefined }>;
}

/**
 * A provider's own fields, in manifest order: the keys its `settings` names
 * (what its readiness counts) and the fields grouped to it (`group: <id>`,
 * optional ones such as a default parcel weight). Empty when it declares
 * none: it then uses the app's general settings.
 */
export function providerOwnSettingKeys(source: PluginSettingsLayoutSource, providerId: string): string[] {
  const provider = source.providers.find((entry) => entry.id === providerId);
  if (!provider) return [];
  const named = new Set(provider.settings ?? []);
  return source.settings.filter((field) => named.has(field.key) || field.group === providerId).map((field) => field.key);
}

/** Every key some provider owns. */
function providerOwnedKeys(source: PluginSettingsLayoutSource): Set<string> {
  return new Set(source.providers.flatMap((provider) => providerOwnSettingKeys(source, provider.id)));
}

/** The app-wide fields (no provider owns them), in manifest order. */
export function appWideSettingKeys(source: PluginSettingsLayoutSource): string[] {
  const owned = providerOwnedKeys(source);
  return source.settings.filter((field) => !owned.has(field.key)).map((field) => field.key);
}

/**
 * The fields shown with a provider where the merchant sets it up: its own,
 * or, when it declares none (a single-provider app such as a payment
 * gateway), the app's general settings.
 */
export function providerSettingKeys(source: PluginSettingsLayoutSource, providerId: string): string[] {
  if (!source.providers.some((entry) => entry.id === providerId)) return [];
  const own = providerOwnSettingKeys(source, providerId);
  return own.length > 0 ? own : appWideSettingKeys(source);
}

export interface PluginSettingsSection {
  /** null: the fields in no declared group (shown first). */
  group: { id: string; title: string; description: string | null } | null;
  keys: string[];
}

/**
 * The app page's settings sections: the ungrouped app-wide fields, then each
 * declared group (by `order`, then manifest order) with its fields. A section
 * without fields is left out.
 */
export function appSettingsSections(source: PluginSettingsLayoutSource): PluginSettingsSection[] {
  const keys = new Set(appWideSettingKeys(source));
  const declared = new Set(source.admin.settingsGroups.map((group) => group.id));
  const fields = source.settings.filter((field) => keys.has(field.key));
  const sections: PluginSettingsSection[] = [];
  const general = fields.filter((field) => field.group === undefined || !declared.has(field.group)).map((field) => field.key);
  if (general.length > 0) sections.push({ group: null, keys: general });
  const groups = source.admin.settingsGroups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => a.group.order - b.group.order || a.index - b.index);
  for (const { group } of groups) {
    const grouped = fields.filter((field) => field.group === group.id).map((field) => field.key);
    if (grouped.length > 0) sections.push({ group: { id: group.id, title: group.title, description: group.description ?? null }, keys: grouped });
  }
  return sections;
}

/**
 * A field's label where its provider is not in view (an activation message,
 * the app's required settings): "Pathao: Client ID" for a provider's own
 * field, the plain label otherwise. Where the provider is in view (its own
 * sheet, its readiness), the plain label reads right.
 */
export function qualifiedSettingLabel(
  source: {
    settings: ReadonlyArray<{ key: string; label: string; group?: string | undefined }>;
    admin: PluginSettingsLayoutSource["admin"];
    providers: ReadonlyArray<{ id: string; name: string; settings?: readonly string[] | undefined }>;
  },
  key: string,
): string {
  const field = source.settings.find((entry) => entry.key === key);
  if (!field) return key;
  const owner = source.providers.find((provider) => providerOwnSettingKeys(source, provider.id).includes(key));
  return owner ? `${owner.name}: ${field.label}` : field.label;
}
