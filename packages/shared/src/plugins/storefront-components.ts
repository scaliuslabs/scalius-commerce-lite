// Storefront components (docs/STOREFRONT-COMPONENTS.md): the presentation an
// app compiles once and the storefront runs at the edge. An app's storefront
// module draws its sections and fills theme slots (the header, the footer,
// the product card) from the merchant's settings and the data the page
// already read. It is a pure function of its input: no network, no storage,
// no bindings. The storefront calls it once per page batch, in its own
// isolate (Workers Paid, `LOADER`) or compiled in (bundled apps, every plan),
// with the same input and the same output. Its client code runs only as
// declared islands, its CSS is one stylesheet, its files are immutable and
// served from the store's own origin.
//
// Part of the versioned plugin API: within `PLUGIN_API_VERSION` the data
// shapes only gain optional fields and the render protocol keeps its ABI.

import { z } from "zod";
import {
  STOREFRONT_COMPONENT_SLOTS,
  type StorefrontComponentSlot,
  type StorefrontImage,
  type StorefrontProductCard,
  type StorefrontResolvedSettings,
  type StorefrontResolvedValue,
} from "./storefront-protocol";
import { PLUGIN_HOST_PATTERN, PLUGIN_NAME_PATTERN } from "./manifest-patterns";
import {
  PLUGIN_PRODUCT_ID,
  PLUGIN_PRODUCT_SOURCE,
  pluginSettingsSchemaSchema,
  resolvePluginSettingValues,
  type PluginSettingItem,
  type PluginSettingsSchema,
} from "./settings-schema";

/** The zod-free part (constants, data shapes, render messages): ./storefront-protocol.ts. */
export * from "./storefront-protocol";

// ── Manifest ──────────────────────────────────────────────────────────────

const name = z.string().regex(PLUGIN_NAME_PATTERN);
const title = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);

/** A theme slot the app's storefront module fills (`storefront.slots`). */
export const storefrontSlotDeclarationSchema = z.object({
  /** Unique per app: the theme names it `<plugin id>/<id>`. */
  id: name,
  slot: z.enum(STOREFRONT_COMPONENT_SLOTS),
  name: title,
  description: description.optional(),
  settings: pluginSettingsSchemaSchema.default([]),
}).strict();
export type StorefrontSlotDeclaration = z.infer<typeof storefrontSlotDeclarationSchema>;

/**
 * A ready-made look (`storefront.templates`): theme values the template
 * library applies like a built-in template, keeping the merchant's content.
 * `theme` holds any of the document's `tokens`, `blocks` and `apps` and the
 * homepage `sections`; the API checks it against the live document schema
 * when it lists the template, so a template that no longer fits is hidden.
 */
export const storefrontTemplateDeclarationSchema = z.object({
  id: name,
  name: title,
  description: description.optional(),
  theme: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 64 * 1024, "A template's theme is at most 64 KiB."),
}).strict();
export type StorefrontTemplateDeclaration = z.infer<typeof storefrontTemplateDeclarationSchema>;

/** A client module the app's markup mounts (`storefront.islands`, built from `src/islands/<name>.ts`). */
export const storefrontIslandDeclarationSchema = z.object({
  name,
  description: description.optional(),
}).strict();

export const storefrontComponentsManifestSchema = {
  slots: z.array(storefrontSlotDeclarationSchema).max(10).default([]),
  templates: z.array(storefrontTemplateDeclarationSchema).max(5).default([]),
  islands: z.array(storefrontIslandDeclarationSchema).max(10).default([]),
  /** The package ships `storefront/styles.css`; pages that show the app's components link it. */
  stylesheet: z.boolean().default(false),
  /**
   * Hosts the app's islands may reach from the buyer's browser (CSP
   * `connect-src`, `img-src`). Shown to the Super Admin who activates it.
   */
  connect: z.array(z.string().regex(PLUGIN_HOST_PATTERN)).max(10).default([]),
};

// ── Resolving settings ────────────────────────────────────────────────────

/** The list key of one picked product (a `product` setting): `product:<id>`. */
export function storefrontProductKey(productId: string): string {
  return `product:${productId}`;
}

/** What a component's settings need read before it renders: images by media id, product lists by source. */
export interface StorefrontSettingNeeds {
  mediaIds: string[];
  products: Array<{ source: string; limit: number }>;
}

/**
 * The reads a placement's stored values need (`image` and `products`
 * settings, and images inside `list` items), after resolving them against
 * the schema as it is now. A product source appears once, with its largest limit.
 */
export function storefrontSettingNeeds(schema: PluginSettingsSchema, stored: unknown): StorefrontSettingNeeds {
  const values = resolvePluginSettingValues(schema, stored);
  const mediaIds = new Set<string>();
  const products = new Map<string, number>();
  for (const field of schema) {
    const value = values[field.key];
    if (field.type === "image" && typeof value === "string") mediaIds.add(value);
    else if (field.type === "products" && typeof value === "string" && PLUGIN_PRODUCT_SOURCE.test(value)) {
      products.set(value, Math.max(products.get(value) ?? 0, field.limit));
    } else if (field.type === "product" && typeof value === "string" && PLUGIN_PRODUCT_ID.test(value)) {
      products.set(storefrontProductKey(value), 1);
    } else if (field.type === "list" && Array.isArray(value)) {
      const imageKeys = field.fields.filter((item) => item.type === "image").map((item) => item.key);
      for (const item of value as PluginSettingItem[]) {
        for (const key of imageKeys) if (typeof item[key] === "string" && item[key] !== "") mediaIds.add(item[key] as string);
      }
    }
  }
  return { mediaIds: [...mediaIds], products: [...products].map(([source, limit]) => ({ source, limit })) };
}

/** Reads a resolution draws on: the images and product lists `storefrontSettingNeeds` named. */
export interface StorefrontSettingData {
  image(mediaId: string): StorefrontImage | null;
  products(source: string): readonly StorefrontProductCard[];
}

/**
 * A placement's settings as its component gets them: stored values resolved
 * against the schema (defaults, dropped stale values), each image id as its
 * image (null when gone), each product source as up to `limit` cards (none
 * unset), each list item's images resolved. Never fails.
 */
export function resolveStorefrontSettings(schema: PluginSettingsSchema, stored: unknown, data: StorefrontSettingData): StorefrontResolvedSettings {
  const values = resolvePluginSettingValues(schema, stored);
  const settings: StorefrontResolvedSettings = {};
  for (const field of schema) {
    if (field.type === "secret") continue;
    const value = values[field.key];
    switch (field.type) {
      case "image":
        settings[field.key] = typeof value === "string" ? data.image(value) : null;
        break;
      case "products":
        settings[field.key] = typeof value === "string" ? data.products(value).slice(0, field.limit) : [];
        break;
      case "product":
        settings[field.key] = typeof value === "string" ? data.products(storefrontProductKey(value))[0] ?? null : null;
        break;
      case "list": {
        const items = Array.isArray(value) ? value as PluginSettingItem[] : [];
        settings[field.key] = items.map((item) => {
          const resolved: Record<string, string | number | boolean | StorefrontImage | null> = {};
          for (const itemField of field.fields) {
            const entry = item[itemField.key];
            if (itemField.type === "image") resolved[itemField.key] = typeof entry === "string" && entry !== "" ? data.image(entry) : null;
            else resolved[itemField.key] = entry === undefined || entry === "" && itemField.type !== "text" && itemField.type !== "textarea" ? null : entry;
          }
          return resolved;
        });
        break;
      }
      default:
        settings[field.key] = value === undefined ? null : value as StorefrontResolvedValue;
    }
  }
  return settings;
}

// ── The layout payload's extensions ───────────────────────────────────────

/**
 * One active app with storefront components, as the layout read lists it:
 * enough for the storefront to load its module, resolve slot settings and
 * name its files, with no further read.
 */
export interface StorefrontExtension {
  pluginId: string;
  version: string;
  /** `bundled` apps are compiled into the storefront; others load in an isolate. */
  source: "bundled" | "registry" | "upload";
  /** The release's bundle SHA-256: names its files and its isolate. */
  release: string;
  /** Section types the storefront module draws. */
  sections: string[];
  /** Each component section's settings schema, by type (the storefront resolves the values). */
  sectionSettings: Record<string, PluginSettingsSchema>;
  slots: Array<{ id: string; slot: StorefrontComponentSlot; settings: PluginSettingsSchema }>;
  islands: string[];
  stylesheet: boolean;
  connect: string[];
}

const RELEASE = /^[0-9a-f]{64}$/;
const HOST = PLUGIN_HOST_PATTERN;

/** The layout payload's `appExtensions`, shape-checked; anything malformed is left out. */
export function readStorefrontExtensions(value: unknown): StorefrontExtension[] {
  if (!Array.isArray(value)) return [];
  const out: StorefrontExtension[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.pluginId !== "string" || typeof item.version !== "string" || typeof item.release !== "string" || !RELEASE.test(item.release)) continue;
    if (item.source !== "bundled" && item.source !== "registry" && item.source !== "upload") continue;
    const names = (list: unknown) => Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && PLUGIN_NAME_PATTERN.test(name)) : [];
    const slots = Array.isArray(item.slots) ? item.slots.flatMap((slot) => {
      if (typeof slot !== "object" || slot === null) return [];
      const record = slot as Record<string, unknown>;
      if (typeof record.id !== "string" || !PLUGIN_NAME_PATTERN.test(record.id)) return [];
      if (!(STOREFRONT_COMPONENT_SLOTS as readonly unknown[]).includes(record.slot)) return [];
      const settings = pluginSettingsSchemaSchema.safeParse(record.settings ?? []);
      return settings.success ? [{ id: record.id, slot: record.slot as StorefrontComponentSlot, settings: settings.data }] : [];
    }) : [];
    const sectionSettings: Record<string, PluginSettingsSchema> = {};
    if (typeof item.sectionSettings === "object" && item.sectionSettings !== null) {
      for (const [type, schema] of Object.entries(item.sectionSettings as Record<string, unknown>)) {
        if (!PLUGIN_NAME_PATTERN.test(type)) continue;
        const parsed = pluginSettingsSchemaSchema.safeParse(schema);
        if (parsed.success) sectionSettings[type] = parsed.data;
      }
    }
    out.push({
      pluginId: item.pluginId,
      version: item.version,
      source: item.source,
      release: item.release,
      sections: names(item.sections),
      sectionSettings,
      slots,
      islands: names(item.islands),
      stylesheet: item.stylesheet === true,
      connect: Array.isArray(item.connect) ? item.connect.filter((host): host is string => typeof host === "string" && HOST.test(host)) : [],
    });
  }
  return out;
}

