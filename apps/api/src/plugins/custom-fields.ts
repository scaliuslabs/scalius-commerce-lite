// `ctx.customFields`: a plugin reads and writes only the custom fields its
// manifest declares, in its own namespace (COMMERCE-HOOKS H4: namespace =
// plugin id). Declared definitions are created on first write, owned by the
// plugin, so the merchant sees them on the resource's Custom fields card.

import type { Database } from "@scalius/database/client";
import {
  createCustomFieldDefinition,
  readCustomFieldValues,
  setCustomFieldValues,
} from "@scalius/core/modules/custom-fields";
import { PluginError } from "@scalius/core/modules/plugins";
import type { CustomFieldOwnerType, CustomFieldType, CustomFieldWriter } from "@scalius/shared/custom-fields";
import type { PluginBridgeAuthority } from "./bridge";

/** A plugin's custom-field namespace is its id (`acme.loyalty`). */
export function pluginCustomFieldNamespace(pluginId: string): string {
  return pluginId;
}

export async function setPluginCustomFieldValues(
  db: Database,
  pluginId: string,
  declared: PluginBridgeAuthority["customFields"],
  ownerType: string,
  ownerId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const byKey = new Map(declared.map((field) => [field.key, field]));
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  const undeclared = keys.find((key) => !byKey.has(key));
  if (undeclared) throw new PluginError("custom_fields.undeclared", `Custom field ${ownerType}.${undeclared} is not declared in the manifest.`);
  const namespace = pluginCustomFieldNamespace(pluginId);
  const writer: CustomFieldWriter = { kind: "plugin", pluginId };
  const type = ownerType as CustomFieldOwnerType;
  const owner = await readCustomFieldValues(db, type, ownerId);
  const definitionIds = new Map(owner.fields
    .filter((entry) => entry.definition.namespace === namespace)
    .map((entry) => [entry.definition.key, entry.definition.id]));
  for (const key of keys) {
    if (definitionIds.has(key)) continue;
    const field = byKey.get(key)!;
    const created = await createCustomFieldDefinition(db, {
      ownerType: type,
      namespace,
      key,
      name: field.name,
      description: field.description ?? null,
      type: field.type as CustomFieldType,
      storefrontVisible: field.storefrontVisible,
      ...(field.to ? { validations: { to: field.to } } : {}),
    }, { writer });
    definitionIds.set(key, created.id);
  }
  await setCustomFieldValues(db, type, ownerId, {
    values: keys.map((key) => ({ definitionId: definitionIds.get(key)!, value: values[key] })),
  }, { writer });
}
