import type { Database } from "@scalius/database/client";
import { customFieldDefinitions, objectTypes, pluginInstallations } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ValidationError } from "@scalius/core/errors";
import { pluginSettingsSchemaSchema, type PluginSettingsSchema } from "@scalius/shared/plugins";
import {
  bindingSettingType,
  bindingSourceCompatible,
  parseSettingSource,
  storefrontThemeDocumentSchema,
  type BindingSettingType,
  type SettingBindings,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";

type RecordValue = Record<string, unknown>;
type BindingSite = {
  path: string[];
  settingsPath: string[];
  values: unknown;
  bindings: SettingBindings;
  owners: string[];
  app?: { id: string; surface: string; kind: "sections" | "components" | "skins"; target?: string };
};

const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function resourceOwners(path: string[]): string[] {
  if (path[0] === "pages" && path[1] === "templates") {
    if (path[2] === "product" || path[2] === "page") return [path[2]];
    if (path[2] === "collection") return ["category", "collection", "brand"];
  }
  if (path[0] === "blocks") {
    if (path[1] === "product" || path[1] === "card") return ["product"];
    if (path[1] === "listing") return ["category", "collection", "brand"];
  }
  if (path[0] === "apps" && path[1] === "skins") {
    if (path[2] === "product-main" || path[2] === "product-card") return ["product"];
    if (path[2] === "listing-main") return ["category", "collection", "brand"];
  }
  return [];
}

function bindingSites(theme: StorefrontThemeDocument): BindingSite[] {
  const sites: BindingSite[] = [];
  function visit(value: unknown, path: string[], parent?: RecordValue): void {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, [...path, String(index)]));
    if (!record(value)) return;
    if (record(value.bindings) && Object.keys(value.bindings).length) {
      const appSection = value.type === "app" && record(value.settings);
      const settingsPath = appSection ? [...path, "settings", "values"]
        : "settings" in value ? [...path, "settings"] : "values" in value ? [...path, "values"] : path;
      const values = appSection ? (value.settings as RecordValue).values : value.settings ?? value.values ?? value;
      const appKey = appSection ? (value.settings as RecordValue).app : value.app;
      const [id, surface] = typeof appKey === "string" ? appKey.split("/") : [];
      const target = path.at(-1) === "skin" && typeof parent?.type === "string" ? `section:${parent.type}`
        : path[0] === "apps" && path[1] === "skins" ? path[2] : undefined;
      sites.push({
        path, settingsPath, values, bindings: value.bindings as SettingBindings, owners: resourceOwners(path),
        ...(id && surface ? { app: { id, surface, kind: appSection ? "sections" : target ? "skins" : "components", target } } : {}),
      });
    }
    for (const [key, item] of Object.entries(value)) if (key !== "bindings") visit(item, [...path, key], value);
  }
  visit(theme, []);
  return sites;
}

function unwrap(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return unwrap(schema.unwrap() as z.ZodType);
  return schema;
}

/** The selected union branch and existing list item own the destination's type. */
function schemaAt(schema: z.ZodType, value: unknown, path: string[]): z.ZodType | null {
  schema = unwrap(schema);
  if (!path.length) return schema;
  if (schema instanceof z.ZodUnion) {
    const option = (schema.options as z.ZodType[]).find((candidate) => candidate.safeParse(value).success);
    return option ? schemaAt(option, value, path) : null;
  }
  const [key, ...rest] = path;
  if (schema instanceof z.ZodObject && key && Object.hasOwn(schema.shape, key)) {
    return schemaAt(schema.shape[key]!, record(value) ? value[key] : undefined, rest);
  }
  if (schema instanceof z.ZodArray && key && /^(0|[1-9]\d*)$/.test(key) && Array.isArray(value) && Number(key) < value.length) {
    return schemaAt(schema.element as z.ZodType, value[Number(key)], rest);
  }
  if (schema instanceof z.ZodRecord && key && record(value) && Object.hasOwn(value, key)) {
    return schemaAt(schema.valueType as z.ZodType, value[key], rest);
  }
  return null;
}

function appSettingType(schema: PluginSettingsSchema, values: unknown, path: string[]): BindingSettingType | null {
  const field = schema.find((item) => item.key === path[0]);
  if (!field) return null;
  if (path.length === 1) return bindingSettingType(field.type, field.key);
  if (field.type !== "list" || path.length !== 3 || !/^(0|[1-9]\d*)$/.test(path[1]!)) return null;
  const items = record(values) ? values[field.key] : undefined;
  if (!Array.isArray(items) || Number(path[1]) >= items.length) return null;
  const item = field.fields.find((entry) => entry.key === path[2]);
  return item ? bindingSettingType(item.type, item.key) : null;
}

function assertObjectTypeLimit(theme: StorefrontThemeDocument, sites: BindingSite[]): void {
  const pages = new Map<string, Set<string>>();
  const sectionPages: Array<[string, StorefrontThemeDocument["pages"]["home"]]> = [
    ["pages.home", theme.pages.home],
    ...Object.entries(theme.pages.templates).map(([key, page]): [string, typeof page.sections] => [`pages.templates.${key}`, page.sections]),
    ...Object.entries(theme.pages.landing).map(([key, page]): [string, typeof page.sections] => [`pages.landing.${key}`, page.sections]),
  ];
  for (const [page, sections] of sectionPages) {
    pages.set(page, new Set(sections.flatMap((section) => section.type === "objects" && !section.hidden && section.settings.typeId
      ? [section.settings.typeId.replace(/^oty_/, "")] : [])));
  }
  for (const site of sites) {
    const page = site.path[0] === "pages" ? site.path.slice(0, site.path[1] === "home" ? 2 : 3).join(".") : "global";
    const types = pages.get(page) ?? new Set<string>();
    for (const binding of Object.values(site.bindings)) {
      const source = parseSettingSource(binding.source);
      if (source?.kind === "object-field" || source?.kind === "object-list") types.add(`${source.namespace}.${source.type}`);
    }
    pages.set(page, types);
  }
  const global = pages.get("global") ?? [];
  for (const [path, types] of pages) {
    if (new Set([...global, ...types]).size > 4) {
      throw new ValidationError("Connect at most four object types on one page.", [{ path, message: "Global block sources count toward the page's four object types." }]);
    }
  }
}

function appSchema(manifest: string | undefined, app: NonNullable<BindingSite["app"]>): PluginSettingsSchema | null {
  try {
    const parsed: unknown = JSON.parse(manifest ?? "null");
    const storefront = record(parsed) && record(parsed.storefront) ? parsed.storefront : null;
    const declarations = storefront?.[app.kind];
    if (!Array.isArray(declarations)) return null;
    const surface = declarations.find((item: unknown) => record(item) && (app.kind === "skins" ? item.id === app.surface && item.target === app.target : item.type === app.surface));
    const settings = pluginSettingsSchemaSchema.safeParse(surface?.settings ?? null);
    return settings.success ? settings.data : null;
  } catch { return null; }
}

function objectFields(serialized: string): Array<{ key: string; type: string }> {
  try {
    const fields: unknown = JSON.parse(serialized);
    return Array.isArray(fields) ? fields.filter((field): field is { key: string; type: string } => record(field) && typeof field.key === "string" && typeof field.type === "string") : [];
  } catch { return []; }
}

function listFieldsCompatible(
  fields: Array<{ key: string; type: string }>,
  destination: z.ZodType | null,
  appField: PluginSettingsSchema[number] | undefined,
): boolean {
  if (appField?.type === "list") {
    return appField.fields.every((item) => {
      const source = fields.find((field) => field.key === item.key);
      const type = bindingSettingType(item.type, item.key);
      return source ? Boolean(type && bindingSourceCompatible(type, source.type)) : !item.required;
    });
  }
  const item = destination instanceof z.ZodArray ? unwrap(destination.element as z.ZodType) : null;
  if (!(item instanceof z.ZodObject)) return false;
  return Object.entries(item.shape).every(([key, schema]) => {
    const target = schema as z.ZodType;
    const source = fields.find((field) => field.key === key);
    if (!source) return target.safeParse(undefined).success;
    const type = bindingSettingType(unwrap(target).type, key);
    return type ? bindingSourceCompatible(type, source.type) : unwrap(target) instanceof z.ZodObject && source.type === "json";
  });
}

/** Dashboard, agent, restore and publish writes share the same live definition checks. */
export async function assertThemeBindings(db: Database, theme: StorefrontThemeDocument): Promise<void> {
  const sites = bindingSites(theme);
  const fields = (theme.blocks.card as typeof theme.blocks.card & { fields?: string[] }).fields ?? [];
  assertObjectTypeLimit(theme, sites);
  if (!sites.length && !fields.length) return;
  const sources = sites.flatMap((site) => Object.values(site.bindings).map((binding) => parseSettingSource(binding.source)));
  const fieldKeys = [...new Set([...fields, ...sources.flatMap((source) => source?.kind === "custom-field" ? [`${source.namespace}.${source.key}`] : [])])];
  const typeKeys = [...new Set(sources.flatMap((source) => source?.kind === "object-field" || source?.kind === "object-list" ? [`${source.namespace}.${source.type}`] : []))];
  const appIds = [...new Set(sites.flatMap((site) => site.app ? [site.app.id] : []))];
  const [definitions, types, apps] = await Promise.all([
    fieldKeys.length ? db.select({ owner: customFieldDefinitions.ownerType, namespace: customFieldDefinitions.namespace, key: customFieldDefinitions.key, type: customFieldDefinitions.type })
      .from(customFieldDefinitions).where(and(eq(customFieldDefinitions.storefrontVisible, true),
        sql`${customFieldDefinitions.namespace} || '.' || ${customFieldDefinitions.key} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(fieldKeys)}))`)) : [],
    typeKeys.length ? db.select({ namespace: objectTypes.namespace, type: objectTypes.type, fields: objectTypes.fieldsJson, handles: objectTypes.handleEnabled })
      .from(objectTypes).where(and(eq(objectTypes.storefront, true),
        sql`${objectTypes.namespace} || '.' || ${objectTypes.type} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(typeKeys)}))`)) : [],
    appIds.length ? db.select({ id: pluginInstallations.pluginId, manifest: pluginInstallations.manifestJson }).from(pluginInstallations)
      .where(and(eq(pluginInstallations.status, "active"), sql`${pluginInstallations.pluginId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(appIds)}))`)) : [],
  ]);
  const issues: Array<{ path: string; message: string }> = [];
  for (const field of fields) {
    if (!definitions.some((definition) => definition.owner === "product" && !["object_reference", "list.object_reference"].includes(definition.type) && `${definition.namespace}.${definition.key}` === field)) {
      issues.push({ path: "blocks.card.fields", message: `Card field ${field} must be a storefront-visible product field.` });
    }
  }
  for (const site of sites) {
    const settings = site.app ? appSchema(apps.find((app) => app.id === site.app!.id)?.manifest, site.app) : null;
    for (const [path, binding] of Object.entries(site.bindings)) {
      const source = parseSettingSource(binding.source);
      const segments = path.split(".");
      const destination = site.app ? null : schemaAt(storefrontThemeDocumentSchema, theme, [...site.settingsPath, ...segments]);
      const settingType = site.app ? settings && appSettingType(settings, site.values, segments)
        : destination && bindingSettingType(destination.type, segments.at(-1)!);
      const issuePath = [...site.path, "bindings", path].join(".");
      if (!settingType || segments.includes("bindings")) {
        issues.push({ path: issuePath, message: "Choose an existing setting that supports dynamic sources." });
        continue;
      }
      let sourceTypes: string[] = [];
      if (source?.kind === "resource" && site.owners.length) {
        sourceTypes = [{ title: "single_line_text", description: "multi_line_text", image: "media_reference", url: "url" }[source.field]];
      } else if (source?.kind === "custom-field") {
        sourceTypes = definitions.filter((definition) => site.owners.includes(definition.owner) && definition.namespace === source.namespace && definition.key === source.key).map((definition) => definition.type);
      } else if (source?.kind === "object-field" || source?.kind === "object-list") {
        const type = types.find((item) => item.namespace === source.namespace && item.type === source.type);
        if (type && source.kind === "object-list" && listFieldsCompatible(objectFields(type.fields), destination, settings?.find((field) => field.key === path))) sourceTypes = ["object-list"];
        if (type?.handles && source.kind === "object-field") {
          const field = objectFields(type.fields).find((field) => field.key === source.field);
          if (field) sourceTypes = [field.type];
        }
      }
      if (!sourceTypes.length || !sourceTypes.every((sourceType) => bindingSourceCompatible(settingType, sourceType))) {
        issues.push({ path: issuePath, message: "Choose a public source whose type matches this setting and page." });
      }
    }
  }
  if (issues.length) throw new ValidationError(issues[0]!.message, issues);
}
