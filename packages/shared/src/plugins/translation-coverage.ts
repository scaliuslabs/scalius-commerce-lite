// Which words an app's manifest shows people and whether each comes in a
// given language (`translations.<tag>`). `missing`: a visible string the
// manifest can translate but doesn't. `noSlot`: a visible string the
// manifest has no translation slot for yet (checkout inputs, objects, custom
// fields, jobs): the platform's gap, listed so it can't grow unseen.
// First-party apps must ship every language the dashboard speaks
// (plugins/first-party-languages.test.ts).
import type { PluginManifestInput } from "./manifest";

export interface TranslationCoverage {
  missing: string[];
  noSlot: string[];
}

type Manifest = PluginManifestInput;

export function translationCoverage(manifest: Manifest, tag: string): TranslationCoverage {
  const text = manifest.translations?.[tag];
  const missing: string[] = [];
  const noSlot: string[] = [];
  const need = (path: string, translated: unknown) => {
    if (typeof translated !== "string" || !translated.trim()) missing.push(path);
  };
  need("name", text?.name);
  need("description", text?.description);
  if (manifest.tagline) need("tagline", text?.tagline);
  for (const page of manifest.admin?.pages ?? []) {
    need(`admin.pages.${page.id}`, text?.pages?.[page.id]);
    for (const tab of page.tabs ?? []) need(`admin.pages.${page.id}.tabs.${tab.id}`, text?.tabs?.[page.id]?.[tab.id]);
  }
  for (const card of manifest.admin?.cards ?? []) need(`admin.cards.${card.id}`, text?.cards?.[card.id]);
  for (const action of manifest.admin?.actions ?? []) need(`admin.actions.${action.id}`, text?.actions?.[action.id]);
  for (const widget of manifest.admin?.widgets ?? []) need(`admin.widgets.${widget.id}`, text?.widgets?.[widget.id]);
  for (const column of manifest.admin?.listColumns ?? []) need(`admin.listColumns.${column.id}`, text?.listColumns?.[column.id]);
  for (const entry of manifest.admin?.timeline ?? []) need(`admin.timeline.${entry.kind}`, text?.timeline?.[entry.kind]);
  for (const group of manifest.admin?.settingsGroups ?? []) {
    need(`admin.settingsGroups.${group.id}.title`, text?.settingsGroups?.[group.id]?.title);
    if (group.description) need(`admin.settingsGroups.${group.id}.description`, text?.settingsGroups?.[group.id]?.description);
  }
  for (const setting of manifest.settings ?? []) {
    const own = text?.settings?.[setting.key];
    need(`settings.${setting.key}.label`, own?.label);
    if (setting.help) need(`settings.${setting.key}.help`, own?.help);
    for (const option of "options" in setting ? setting.options ?? [] : []) {
      need(`settings.${setting.key}.options.${option.value}`, own?.options?.[option.value]);
    }
  }
  for (const feature of manifest.features ?? []) {
    need(`features.${feature.id}.name`, text?.features?.[feature.id]?.name);
    if (feature.description) need(`features.${feature.id}.description`, text?.features?.[feature.id]?.description);
  }
  // Visible, but the manifest can't translate them yet.
  for (const field of manifest.checkout?.attributes ?? []) noSlot.push(`checkout.attributes.${field.key}`);
  for (const input of manifest.checkout?.lineInputs ?? []) noSlot.push(`checkout.lineInputs.${input.key}`);
  for (const [name] of Object.entries(manifest.objects ?? {})) noSlot.push(`objects.${name}`);
  for (const field of manifest.customFields ?? []) noSlot.push(`customFields.${field.ownerType}.${field.key}`);
  for (const job of manifest.jobs ?? []) noSlot.push(`jobs.${job.name}`);
  return { missing, noSlot };
}
