import { z } from "zod";
import { formatNumber, numberLocale } from "../locale-format";
import { canonicalStorefrontLink } from "./links";
import type { PluginSettingsSchema } from "../plugins/settings-schema";

export type BindingSettingType = "text" | "textarea" | "richtext" | "image" | "link" | "url" | "number" | "boolean" | "color" | "product" | "products" | "list";
export type SettingBinding = { source: string };
export type SettingBindings = Record<string, SettingBinding>;
export type StorefrontSettingBindings = SettingBindings;
export type BindingResourceSelector = { ownerType: "product" | "category" | "collection" | "brand" | "page"; id: string };
export function parseBindingResourceSelector(value: unknown): BindingResourceSelector | undefined {
  const match = typeof value === "string" ? /^(product|category|collection|brand|page):([A-Za-z0-9_-]{1,64})$/.exec(value) : null;
  return match ? { ownerType: match[1] as BindingResourceSelector["ownerType"], id: match[2]! } : undefined;
}
export type SettingSource =
  | { kind: "resource"; field: "title" | "description" | "image" | "url" }
  | { kind: "custom-field"; namespace: string; key: string }
  | { kind: "object-field"; namespace: string; type: string; handle: string; field: string }
  | { kind: "object-list"; namespace: string; type: string };

const safePart = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function safeParts(parts: string[]): boolean { return parts.every((part) => safePart.test(part) && !forbidden.has(part)); }

export function parseSettingSource(value: string): SettingSource | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const parts = value.split(".");
  if (!safeParts(parts)) return null;
  if (parts[0] === "resource") {
    if (parts.length === 2 && ["title", "description", "image", "url"].includes(parts[1]!)) return { kind: "resource", field: parts[1] as "title" | "description" | "image" | "url" };
    if (parts[1] === "cf" && parts.length >= 4) return { kind: "custom-field", namespace: parts.slice(2, -1).join("."), key: parts.at(-1)! };
  }
  if (parts[0] === "object") {
    if (parts.length >= 5) return { kind: "object-field", namespace: parts.slice(1, -3).join("."), type: parts.at(-3)!, handle: parts.at(-2)!, field: parts.at(-1)! };
    if (parts.length >= 3) return { kind: "object-list", namespace: parts.slice(1, -1).join("."), type: parts.at(-1)! };
  }
  return null;
}

export const storefrontSettingBindingsSchema = z.record(
  z.string().max(160).refine((path) => safeParts(path.split(".")), "Use a setting path."),
  z.object({ source: z.string().refine((source) => parseSettingSource(source) !== null, "Use a resource or object source.") }).strict(),
).refine((bindings) => Object.keys(bindings).length <= 20, "At most 20 connected settings.");

export function bindingSettingType(kind: string, key: string): BindingSettingType | null {
  const name = key.split(".").at(-1) ?? key;
  if (["image", "mediaId", "phoneImage", "logo"].includes(name) || /(?:Image|MediaId)$/.test(name)) return "image";
  if (["link", "href", "url"].includes(name)) return "link";
  if (name === "productId") return "product";
  if (name === "productIds") return "products";
  if (name === "html") return "richtext";
  if (name === "color" || name.endsWith("Color")) return "color";
  if (["text", "string", "textarea", "richtext", "image", "link", "url", "number", "boolean", "color", "product", "products", "list"].includes(kind)) return (kind === "string" ? "text" : kind) as BindingSettingType;
  if (kind === "array") return "list";
  return null;
}

const compatible: Record<BindingSettingType, readonly string[]> = {
  text: ["single_line_text", "multi_line_text", "integer", "decimal"],
  textarea: ["single_line_text", "multi_line_text", "integer", "decimal"],
  richtext: ["multi_line_text", "json"], image: ["media_reference"],
  link: ["url", "product_reference", "collection_reference"], url: ["url", "product_reference", "collection_reference"],
  number: ["integer", "decimal"], boolean: ["boolean"], color: ["color"],
  product: ["product_reference"], products: ["list.product_reference", "collection_reference"], list: ["object", "object-list"],
};
export function bindingSourceCompatible(settingType: BindingSettingType, sourceType: string): boolean {
  return compatible[settingType].includes(sourceType);
}

export function collectObjectBindingRequests(value: unknown): Array<{ namespace: string; type: string; handles: string[]; list: boolean }> {
  const types = new Map<string, { namespace: string; type: string; handles: string[]; list: boolean }>();
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (record.bindings && typeof record.bindings === "object") {
      for (const binding of Object.values(record.bindings)) {
        const source = parseSettingSource((binding as SettingBinding)?.source);
        if (source?.kind === "object-field" || source?.kind === "object-list") {
          const key = `${source.namespace}.${source.type}`;
          const entry = types.get(key) ?? { namespace: source.namespace, type: source.type, handles: [], list: false };
          if (source.kind === "object-list") entry.list = true;
          else if (!entry.handles.includes(source.handle)) entry.handles.push(source.handle);
          types.set(key, entry);
        }
      }
    }
    Object.entries(record).forEach(([key, child]) => { if (key !== "bindings") visit(child); });
  }
  visit(value);
  return [...types.values()].slice(0, 4);
}

export function collectObjectBindingTypes(value: unknown): Array<{ namespace: string; type: string }> {
  return collectObjectBindingRequests(value).map(({ namespace, type }) => ({ namespace, type }));
}

export function hasSettingBindings(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.bindings && Object.keys(record.bindings).length) || Object.entries(record).some(([key, child]) => key !== "bindings" && hasSettingBindings(child));
}

export interface BindingResource {
  title?: unknown; description?: unknown; image?: unknown; url?: unknown;
  imageAsset?: { id: string; url: string; alt: string; width: number | null; height: number | null };
  customFields?: readonly {
    namespace: string; key: string; type: string; value: unknown;
    reference?: { id: string; url: string } | null;
    object?: { handle: string | null; fields: Array<{ key: string; name: string; type: string; value: unknown }> };
  }[];
}
export interface BindingObjects { [type: string]: { fields?: Record<string, string>; records: readonly { handle: string | null; data: Record<string, unknown> }[] } }
export interface SettingBindingContext { resource?: BindingResource | null; objects?: BindingObjects; language?: string; mediaIds?: ReadonlySet<string>; resourceSelector?: BindingResourceSelector }

function sourceValue(source: SettingSource, context: SettingBindingContext): { value: unknown; type?: string; reference?: { id: string; url: string } | null } | undefined {
  if (source.kind === "resource") return { value: context.resource?.[source.field] };
  if (source.kind === "custom-field") {
    const field = context.resource?.customFields?.find((entry) => entry.namespace === source.namespace && entry.key === source.key);
    return field?.type === "media_reference" && !field.reference ? undefined : field;
  }
  const records = context.objects?.[`${source.namespace}.${source.type}`]?.records;
  if (!records) return undefined;
  if (source.kind === "object-list") return { value: records.map((record) => record.data), type: "object-list" };
  const record = records.find((entry) => entry.handle === source.handle);
  return record && Object.hasOwn(record.data, source.field) ? { value: record.data[source.field], type: context.objects?.[`${source.namespace}.${source.type}`]?.fields?.[source.field] } : undefined;
}

/** A missing record/field leaves the literal setting intact. No writes or reads. */
export function resolveSettingBindings<T>(settings: T, bindings: SettingBindings | undefined, context: SettingBindingContext, schema?: z.ZodType, settingTypes?: Readonly<Record<string, BindingSettingType>>): T {
  if (!bindings || !settings || typeof settings !== "object") return settings;
  let result = settings;
  for (const [path, binding] of Object.entries(bindings).slice(0, 20)) {
    const keys = path.split(".");
    if (!safeParts(keys)) continue;
    const source = parseSettingSource(binding?.source);
    if (!source) continue;
    const resolved = sourceValue(source, context);
    if (!resolved || resolved.value === undefined || resolved.value === null) continue;
    let parent: unknown = result;
    for (const key of keys.slice(0, -1)) parent = parent && typeof parent === "object" && Object.hasOwn(parent, key) ? (parent as Record<string, unknown>)[key] : undefined;
    const key = keys.at(-1)!;
    if (!parent || typeof parent !== "object") continue;
    const literal = (parent as Record<string, unknown>)[key];
    const targetSchema = bindingSchemaAt(schema, settings, keys);
    const kind = literal === undefined || literal === null ? typeof resolved.value : typeof literal;
    let type = settingTypes?.[path] ?? bindingSettingType(Array.isArray(literal ?? resolved.value) ? "list" : kind, key);
    if (!settingTypes?.[path]) {
      if (type === "text" && resolved.type === "media_reference") type = "image";
      if (type === "text" && resolved.type === "url") type = "url";
      if (type === "text" && resolved.type === "product_reference") type = "product";
      if (type === "text" && resolved.type === "collection_reference") type = "products";
    }
    if (!type || (resolved.type && !bindingSourceCompatible(type, resolved.type))) continue;
    let value: unknown = resolved.value;
    if ((type === "text" || type === "textarea") && (typeof value === "number" || resolved.type === "decimal")) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      value = formatNumber(numeric, numberLocale(context.language ?? "en"), { maximumFractionDigits: 20 });
    }
    if (type === "number" && typeof value === "string" && resolved.type === "decimal") value = Number(value);
    if (type === "link" || type === "url") {
      value = resolved.reference?.url ?? value;
      value = canonicalStorefrontLink(value);
      if (!value) continue;
    }
    if (type === "image") {
      value = resolved.reference?.id ?? value;
      if (source.kind === "object-field" && context.mediaIds && typeof value === "string" && !context.mediaIds.has(value)) continue;
    }
    if (type === "products" && resolved.type === "collection_reference") value = `collection:${value}`;
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) continue;
    if (type === "boolean" && typeof value !== "boolean") continue;
    if (type === "list" && !Array.isArray(value)) continue;
    if (!["number", "boolean", "list", "products", "link"].includes(type) && typeof value !== "string") continue;
    if (type === "color" && !/^#[0-9a-fA-F]{6}$/.test(String(value))) continue;
    if (source.kind === "object-list" && Array.isArray(value)) {
      const item = unwrappedSchema(targetSchema);
      if (item instanceof z.ZodArray) {
        const element = unwrappedSchema(item.element as z.ZodType);
        if (element instanceof z.ZodObject) value = value.map((entry) => entry && typeof entry === "object"
          ? Object.fromEntries(Object.entries(entry).filter(([field]) => Object.hasOwn(element.shape, field))) : entry);
      }
    }
    if (targetSchema) {
      const parsed = targetSchema.safeParse(value);
      if (!parsed.success) continue;
      value = parsed.data;
    }
    if (result === settings) result = structuredClone(settings);
    let target = result as Record<string, unknown>;
    for (const part of keys.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[key] = value;
  }
  return result;
}

export function resolvePluginSettingBindings<T>(schema: PluginSettingsSchema, values: T, bindings: SettingBindings | undefined, context: SettingBindingContext): T {
  const types: Record<string, BindingSettingType> = {};
  for (const path of Object.keys(bindings ?? {})) {
    const [key, index, childKey] = path.split(".");
    const parent = schema.find((field) => field.key === key);
    const field = parent?.type === "list" && index !== undefined && childKey ? parent.fields.find((child) => child.key === childKey) : parent;
    const type = field && bindingSettingType(field.type, field.key);
    if (type) types[path] = type;
  }
  return resolveSettingBindings(values, bindings, context, undefined, types);
}

/** Resolves placement metadata while retaining it for later object-data resolution. */
export function resolveDocumentBindings<T>(value: T, context: SettingBindingContext, schema?: z.ZodType): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child, index) => resolveDocumentBindings(child, context, bindingSchemaAt(schema, value, [String(index)]))) as T;
  const node = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) result[key] = key === "bindings" ? child : resolveDocumentBindings(child, context, bindingSchemaAt(schema, value, [key]));
  const bindings = node.bindings as SettingBindings | undefined;
  if (bindings) {
    if (node.type === "app" && result.settings && typeof result.settings === "object") {
      const appSettings = result.settings as Record<string, unknown>;
      appSettings.values = resolveSettingBindings(appSettings.values, bindings, context, bindingSchemaAt(schema, value, ["settings", "values"]));
    } else if (result.settings) result.settings = resolveSettingBindings(result.settings, bindings, context, bindingSchemaAt(schema, value, ["settings"]));
    else if (result.values) result.values = resolveSettingBindings(result.values, bindings, context, bindingSchemaAt(schema, value, ["values"]));
    else return resolveSettingBindings(result, bindings, context, schema) as T;
  }
  return result as T;
}

function unwrappedSchema(schema: z.ZodType | undefined): z.ZodType | undefined {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault
    ? unwrappedSchema(schema.unwrap() as z.ZodType) : schema;
}

/** The active strict schema supplies list item keys and each bound value's limits. */
export function bindingSchemaAt(schema: z.ZodType | undefined, value: unknown, path: string[]): z.ZodType | undefined {
  schema = unwrappedSchema(schema);
  if (!schema || !path.length) return schema;
  if (schema instanceof z.ZodUnion) {
    const branch = (schema.options as z.ZodType[]).find((option) => option.safeParse(value).success);
    return bindingSchemaAt(branch, value, path);
  }
  const [key, ...rest] = path;
  const child = value && typeof value === "object" ? (value as Record<string, unknown>)[key!] : undefined;
  if (schema instanceof z.ZodObject) return bindingSchemaAt(schema.shape[key!], child, rest);
  if (schema instanceof z.ZodArray && /^\d+$/.test(key!)) return bindingSchemaAt(schema.element as z.ZodType, child, rest);
  if (schema instanceof z.ZodRecord) return bindingSchemaAt(schema.valueType as z.ZodType, child, rest);
  return undefined;
}
