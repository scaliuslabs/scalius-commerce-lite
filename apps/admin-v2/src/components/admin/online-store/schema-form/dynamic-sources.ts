import { bindingSourceCompatible, type BindingSettingType, type SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import type { CustomFieldOwnerType } from "@scalius/shared/custom-fields";
import type { CustomFieldDefinition } from "~/lib/api-query-options/custom-fields";
import type { ObjectType } from "~/lib/api-query-options/objects";

export type SourceResource = Extract<CustomFieldOwnerType, "product" | "category" | "collection" | "brand" | "page">;
export interface DynamicSourceOption {
  value: string;
  label: string;
  group: "resource" | "fields" | "objects";
  object?: { type: string; field: string };
}

export function dynamicSourceOptions(
  setting: BindingSettingType,
  resource: SourceResource | null,
  fields: readonly CustomFieldDefinition[],
  objects: readonly ObjectType[],
): DynamicSourceOption[] {
  const options: DynamicSourceOption[] = [];
  if (resource) {
    for (const [key, type] of [["title", "single_line_text"], ["description", "multi_line_text"], ["image", "media_reference"], ["url", "url"]] as const) {
      if (bindingSourceCompatible(setting, type)) options.push({ value: `resource.${key}`, label: key, group: "resource" });
    }
    for (const field of fields) {
      if (field.ownerType === resource && field.storefrontVisible && bindingSourceCompatible(setting, field.type)) {
        options.push({ value: `resource.cf.${field.namespace}.${field.key}`, label: field.name, group: "fields" });
      }
    }
  }
  for (const object of objects) {
    if (!object.storefront) continue;
    if (setting === "list") options.push({ value: `object.${object.handle}`, label: object.name, group: "objects" });
    if (!object.handleEnabled) continue;
    for (const field of object.fields) {
      if (bindingSourceCompatible(setting, field.type)) options.push({
        value: `object.${object.handle}.*.${field.key}`,
        label: `${object.name} · ${field.name}`,
        group: "objects",
        object: { type: object.handle, field: field.key },
      });
    }
  }
  return options;
}

/** Empty bindings are omitted; changing a source leaves every literal setting intact. */
export function withSettingBinding(bindings: SettingBindings | undefined, path: string, source: string | null): SettingBindings | undefined {
  const next = { ...bindings };
  if (source) {
    if (!next[path] && Object.keys(next).length >= 20) return bindings;
    next[path] = { source };
  } else delete next[path];
  return Object.keys(next).length ? next : undefined;
}

/** Item moves and removal carry indexed sources with the merchant's item. */
export function reindexSettingBindings(bindings: SettingBindings | undefined, list: string, from: number, to: number | null, duplicate = false): SettingBindings | undefined {
  if (!bindings) return bindings;
  const next: SettingBindings = {};
  for (const [path, binding] of Object.entries(bindings)) {
    const tail = path.startsWith(`${list}.`) ? path.slice(list.length + 1) : "";
    const match = /^(\d+)(\..+)?$/.exec(tail);
    if (!match) { next[path] = binding; continue; }
    const index = Number(match[1]);
    if (to === null && index === from) continue;
    if (duplicate && index === from) next[`${list}.${index}${match[2] ?? ""}`] = { ...binding };
    const changed = duplicate ? index > from ? index + 1 : index === from ? from + 1 : index
      : to === null ? index > from ? index - 1 : index
      : index === from ? to : from < to && index > from && index <= to ? index - 1
        : to < from && index >= to && index < from ? index + 1 : index;
    next[`${list}.${changed}${match[2] ?? ""}`] = binding;
  }
  return Object.keys(next).length ? next : undefined;
}

export function cardCustomFieldOptions(fields: readonly CustomFieldDefinition[]): Array<{ value: string; label: string }> {
  return fields.filter((field) => field.ownerType === "product" && field.storefrontVisible && !["object_reference", "list.object_reference"].includes(field.type))
    .map((field) => ({ value: `${field.namespace}.${field.key}`, label: field.name }));
}
