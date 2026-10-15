/** Theme component data drawn at the edge from the public page batch. */
import type { StorefrontRenderJob } from "@scalius/shared/plugins/storefront-protocol";
import { OBJECT_FIELD_KEY_PATTERN, OBJECT_FIELD_TYPES, OBJECT_FIELDS_MAX, OBJECT_HANDLE_PATTERN, OBJECT_RECORD_MAX_BYTES, OBJECT_SECTION_RECORDS_MAX, parseObjectTypeHandle } from "@scalius/shared/plugins/objects";
import { HOME_MAX_OBJECT_TYPES } from "@scalius/shared/storefront-theme/home-data";
import type { PluginHead } from "@scalius/shared/plugins/storefront";

type ComponentObjects = NonNullable<Extract<StorefrontRenderJob, { kind: "section" }>["objects"]>;

/**
 * A component section's data (docs/STOREFRONT-COMPONENTS.md): the app's
 * storefront module draws it here, at the edge, from these values and the
 * images and product cards its settings name.
 */
export interface HomepageAppComponent {
  pluginId: string;
  type: string;
  values: Record<string, unknown>;
  objects?: ComponentObjects;
  media: Array<{ id: string; url: string; alt: string; width: number | null; height: number | null }>;
  lists: Array<{ source: string; products: unknown[] }>;
}

/** One homepage app section, keyed by its theme section id: a component section's data. */
export interface HomepageAppSurface {
  sectionId: string;
  component: HomepageAppComponent;
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const TYPE = /^[a-z][a-z0-9-]{0,47}$/;

/** A component section's data, shape-checked; null when it is not one. */
export function readAppComponent(value: unknown): HomepageAppComponent | null {
  if (!isRecord(value) || typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) return null;
  if (typeof value.type !== "string" || !TYPE.test(value.type) || !isRecord(value.values)) return null;
  const media = (Array.isArray(value.media) ? value.media : []).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.url !== "string" || !/^https?:\/\/|^\//.test(entry.url)) return [];
    const size = (input: unknown) => (typeof input === "number" && Number.isFinite(input) && input > 0 ? input : null);
    return [{ id: entry.id, url: entry.url, alt: typeof entry.alt === "string" ? entry.alt : "", width: size(entry.width), height: size(entry.height) }];
  });
  const lists = (Array.isArray(value.lists) ? value.lists : []).flatMap((entry) => (
    isRecord(entry) && typeof entry.source === "string" && Array.isArray(entry.products)
      ? [{ source: entry.source, products: entry.products as unknown[] }]
      : []
  ));
  const objects = value.objects === undefined ? undefined : readComponentObjects(value.objects);
  if (objects === null) return null;
  return { pluginId: value.pluginId, type: value.type, values: value.values, media, lists, ...(objects === undefined ? {} : { objects }) };
}

/** Keeps the public object carrier bounded at the batch-to-component boundary. */
function readComponentObjects(value: unknown): ComponentObjects | null {
  if (!isRecord(value) || Object.keys(value).length > HOME_MAX_OBJECT_TYPES) return null;
  const result: ComponentObjects = {};
  for (const [type, data] of Object.entries(value)) {
    if (!parseObjectTypeHandle(type) || !isRecord(data) || !isRecord(data.fields) || !Array.isArray(data.records)) return null;
    if (Object.keys(data.fields).length > OBJECT_FIELDS_MAX || data.records.length > OBJECT_SECTION_RECORDS_MAX) return null;
    const fields: Record<string, string> = {};
    for (const [key, field] of Object.entries(data.fields)) {
      if (!OBJECT_FIELD_KEY_PATTERN.test(key) || typeof field !== "string" || !(OBJECT_FIELD_TYPES as readonly string[]).includes(field)
        || field === "customer_reference" || field === "order_reference") return null;
      fields[key] = field;
    }
    const records: ComponentObjects[string]["records"] = [];
    for (const record of data.records) {
      if (!isRecord(record) || typeof record.id !== "string" || record.id.length < 1 || record.id.length > 128
        || !(record.handle === null || typeof record.handle === "string" && OBJECT_HANDLE_PATTERN.test(record.handle)) || !isRecord(record.data)) return null;
      if (Object.keys(record.data).some((key) => !Object.hasOwn(fields, key))) return null;
      try { if (new TextEncoder().encode(JSON.stringify(record.data)).length > OBJECT_RECORD_MAX_BYTES) return null; } catch { return null; }
      records.push({ id: record.id, handle: record.handle, data: record.data });
    }
    result[type] = { fields, records };
  }
  return result;
}

/** Theme section ids. */
const SURFACE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The homepage's app sections (`sections.apps`) by section id; ones that are not component data are left out. */
export function readHomepageAppSurfaces(value: unknown): Map<string, HomepageAppSurface> {
  const surfaces = new Map<string, HomepageAppSurface>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry) || typeof entry.sectionId !== "string" || !SURFACE_ID.test(entry.sectionId)) continue;
    if (surfaces.has(entry.sectionId)) continue;
    const component = readAppComponent(entry.component);
    if (component) surfaces.set(entry.sectionId, { sectionId: entry.sectionId, component });
  }
  return surfaces;
}

/** The head tags of several surfaces, in order: each meta name or property once (the first wins), each JSON-LD once. */
export function mergeAppHeads(heads: Iterable<PluginHead>): PluginHead {
  const meta: PluginHead["meta"] = [];
  const keys = new Set<string>();
  const jsonLd = new Set<string>();
  for (const head of heads) {
    for (const tag of head.meta) {
      const key = `${tag.attribute}:${tag.key}`;
      if (keys.has(key)) continue;
      keys.add(key);
      meta.push(tag);
    }
    for (const entry of head.jsonLd) jsonLd.add(entry);
  }
  return { meta, jsonLd: [...jsonLd] };
}
