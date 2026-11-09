// Which words an app's manifest shows people and whether each comes in a
// given language (`translations.<tag>`): `missing` lists every visible
// string the manifest can translate but doesn't, from the dashboard's
// (pages, settings, objects, custom fields, jobs) to the buyer's (checkout
// attributes, line inputs, purchase options). First-party apps must ship
// every language the dashboard speaks (plugins/first-party-languages.test.ts).
import type { PluginManifestInput } from "./manifest";

export interface TranslationCoverage {
  missing: string[];
}

type Manifest = PluginManifestInput;

export function translationCoverage(manifest: Manifest, tag: string): TranslationCoverage {
  const text = manifest.translations?.[tag];
  const missing: string[] = [];
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
  for (const channel of manifest.salesChannels ?? []) need(`salesChannels.${channel.id}`, text?.salesChannels?.[channel.id]);
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
  for (const field of manifest.checkout?.attributes ?? []) {
    const own = text?.checkout?.attributes?.[field.key];
    need(`checkout.attributes.${field.key}.label`, own?.label);
    if (field.help) need(`checkout.attributes.${field.key}.help`, own?.help);
    for (const choice of field.choices ?? []) need(`checkout.attributes.${field.key}.choices.${choice.value}`, own?.choices?.[choice.value]);
  }
  for (const input of manifest.checkout?.lineInputs ?? []) {
    const own = text?.checkout?.lineInputs?.[input.key];
    need(`checkout.lineInputs.${input.key}.label`, own?.label);
    if (input.help) need(`checkout.lineInputs.${input.key}.help`, own?.help);
    for (const option of input.options ?? []) need(`checkout.lineInputs.${input.key}.options.${option.value}`, own?.options?.[option.value]);
  }
  for (const option of manifest.checkout?.purchaseOptions ?? []) {
    const own = text?.checkout?.purchaseOptions?.[option.key];
    need(`checkout.purchaseOptions.${option.key}.title`, own?.title);
    if (option.description) need(`checkout.purchaseOptions.${option.key}.description`, own?.description);
  }
  for (const [type, declaration] of Object.entries(manifest.objects ?? {})) {
    const own = text?.objects?.[type];
    need(`objects.${type}.name`, own?.name);
    if (declaration.description) need(`objects.${type}.description`, own?.description);
    for (const field of declaration.fields) {
      need(`objects.${type}.fields.${field.key}.name`, own?.fields?.[field.key]?.name);
      if (field.description) need(`objects.${type}.fields.${field.key}.description`, own?.fields?.[field.key]?.description);
    }
  }
  for (const field of manifest.customFields ?? []) {
    const own = text?.customFields?.[field.ownerType]?.[field.key];
    need(`customFields.${field.ownerType}.${field.key}.name`, own?.name);
    if (field.description) need(`customFields.${field.ownerType}.${field.key}.description`, own?.description);
  }
  for (const job of manifest.jobs ?? []) need(`jobs.${job.name}`, text?.jobs?.[job.name]);
  return { missing };
}
