// Storefront components (docs/STOREFRONT-COMPONENTS.md): the presentation an
// app compiles once and the storefront runs at the edge. An app's storefront
// module draws its sections, its components (in slots and app pages), and skins of core-owned units
// (the header, the footer, the product card, the product page's main part,
// the listing, core sections), from the merchant's settings and the data the
// page already read. It is a pure function of its input: no network, no storage,
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
  STOREFRONT_COMPONENT_TARGETS,
  STOREFRONT_PRODUCT_SLOTS,
  type StorefrontComponentTarget,
  type StorefrontImage,
  type StorefrontSkinTarget,
  type StorefrontProductCard,
  type StorefrontResolvedSettings,
  type StorefrontResolvedValue,
} from "./storefront-protocol";
import { PLUGIN_HOST_PATTERN, PLUGIN_KEY_PATTERN, PLUGIN_URL_NAME_PATTERN, pluginKeySchema, pluginUrlNameSchema } from "./manifest-patterns";
import {
  PLUGIN_PRODUCT_ID,
  PLUGIN_PRODUCT_SOURCE,
  pluginSettingsSchemaSchema,
  resolvePluginSettingValues,
  type PluginSettingItem,
  type PluginSettingsSchema,
} from "./settings-schema";
import { isStorefrontSkinTarget } from "../storefront-theme/skins";

/** The zod-free part (constants, data shapes, render messages): ./storefront-protocol.ts. */
export * from "./storefront-protocol";

// ── Manifest ──────────────────────────────────────────────────────────────

/** Skin, template and page preset ids: snake_case (the theme stores them as `<plugin id>/<id>`). */
const key = pluginKeySchema();
const title = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);

/** The most skins one app declares. */
export const STOREFRONT_SKINS_MAX = 30;

/**
 * A skin the app's storefront module draws (`storefront.skins`): app markup
 * for one core-owned unit (`header`, `footer`, `product_card`,
 * `product_main`, `listing_main`, or a core section `section:<type>`). It
 * gets the unit's public projection and the merchant's values for its
 * settings; core draws the unit whenever it is missing, fails or draws
 * nothing. A skin reads nothing, so its settings name no images or products
 * (ship images in the app's public files).
 */
export const storefrontSkinDeclarationSchema = z.object({
  /** Unique per app: the theme names it `<plugin id>/<id>`. */
  id: key,
  target: z.string().max(64).refine(isStorefrontSkinTarget, "Use header, footer, product_card, product_main, listing_main or section:<core section type>."),
  name: title,
  description: description.optional(),
  settings: pluginSettingsSchemaSchema.default([]),
}).strict();
export type StorefrontSkinDeclaration = z.infer<typeof storefrontSkinDeclarationSchema> & { target: StorefrontSkinTarget };

/**
 * A ready-made look (`storefront.templates`): theme values the template
 * library applies like a built-in template, keeping the merchant's content.
 * `theme` holds any of the document's `tokens`, `blocks` and `apps` and the
 * homepage `sections`, as theme document version `themeVersion` has them.
 * The API upgrades it to the store's version when it lists the template; one
 * that still does not fit is left out of the library and reported on the
 * app's page.
 */
export const storefrontTemplateDeclarationSchema = z.object({
  id: key,
  name: title,
  description: description.optional(),
  /** The theme document version `theme` was written for (absent: 10, `STOREFRONT_DECLARATION_THEME_VERSION`). */
  themeVersion: z.number().int().positive().optional(),
  theme: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 64 * 1024, "A template's theme is at most 64 KiB."),
}).strict();
export type StorefrontTemplateDeclaration = z.infer<typeof storefrontTemplateDeclarationSchema>;

/**
 * A ready-made landing page (`storefront.pagePresets`): sections the editor
 * offers when the merchant makes a new landing page (`/pages/<slug>`), for
 * a campaign, a launch or one product's single-page order. Its `product`
 * settings take the product the merchant picks in the same step. The API
 * upgrades `sections` from `themeVersion` when it lists the preset; one that
 * still does not fit is left out and reported on the app's page.
 */
export const storefrontPagePresetDeclarationSchema = z.object({
  id: key,
  name: title,
  description: description.optional(),
  /** The theme document version `sections` were written for (absent: 10, `STOREFRONT_DECLARATION_THEME_VERSION`). */
  themeVersion: z.number().int().positive().optional(),
  sections: z.array(z.record(z.string(), z.unknown())).min(1).max(24)
    .refine((value) => JSON.stringify(value).length <= 64 * 1024, "A page preset's sections are at most 64 KiB."),
}).strict();
export type StorefrontPagePresetDeclaration = z.infer<typeof storefrontPagePresetDeclarationSchema>;

/** A client module the app's markup mounts (`storefront.islands`, built from `src/islands/<name>.ts`). */
export const storefrontIslandDeclarationSchema = z.object({
  /** Its file (`islands/<name>.js`, a URL path segment): snake_case or kebab-case. */
  name: pluginUrlNameSchema(),
  description: description.optional(),
}).strict();

/** The most components one app declares. */
export const STOREFRONT_COMPONENTS_MAX = 16;

const PRODUCT_SLOTS = new Set<string>(STOREFRONT_PRODUCT_SLOTS);

/**
 * A component the app's storefront module draws (`storefront.components`):
 * app markup at each of its `targets`, a component slot (storefront-protocol.ts)
 * or `page` (an app page its proxy route answers with `{ page: { component } }`).
 * In a product slot it renders where the merchant places it (the product
 * page's app blocks, with their values) and gets the product page; in the
 * other slots it renders for every page with its default values. At most one
 * product slot. Like a skin, it reads nothing: its settings name no images
 * or products.
 */
export const storefrontComponentDeclarationSchema = z.object({
  /** Unique per app: the theme names it `<plugin id>/<type>`. */
  type: key,
  name: title,
  description: description.optional(),
  targets: z.array(z.enum(STOREFRONT_COMPONENT_TARGETS)).min(1).max(STOREFRONT_COMPONENT_TARGETS.length)
    .refine((targets) => new Set(targets).size === targets.length, "Each target appears once.")
    .refine((targets) => targets.filter((target) => PRODUCT_SLOTS.has(target)).length <= 1, "A component has at most one product slot."),
  settings: pluginSettingsSchemaSchema.default([]),
}).strict();
export type StorefrontComponentDeclaration = z.infer<typeof storefrontComponentDeclarationSchema>;

export const storefrontComponentsManifestSchema = {
  components: z.array(storefrontComponentDeclarationSchema).max(STOREFRONT_COMPONENTS_MAX).default([]),
  skins: z.array(storefrontSkinDeclarationSchema).max(STOREFRONT_SKINS_MAX).default([]),
  templates: z.array(storefrontTemplateDeclarationSchema).max(5).default([]),
  pagePresets: z.array(storefrontPagePresetDeclarationSchema).max(8).default([]),
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

export function storefrontProductsKey(productIds: readonly string[]): string {
  return `products:${productIds.join(",")}`;
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
    } else if (field.type === "products" && Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && PLUGIN_PRODUCT_ID.test(id))) {
      const source = storefrontProductsKey(value as string[]);
      products.set(source, Math.max(products.get(source) ?? 0, field.limit));
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
        settings[field.key] = typeof value === "string" ? data.products(value).slice(0, field.limit)
          : Array.isArray(value) ? data.products(storefrontProductsKey(value as string[])).slice(0, field.limit) : [];
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
 * enough for the storefront to load its module, resolve skin and block
 * settings and name its files, with no further read.
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
  skins: Array<{ id: string; target: StorefrontSkinTarget; settings: PluginSettingsSchema }>;
  /** Components (`storefront.components`), drawn at the edge at their targets. */
  components: Array<{ type: string; targets: StorefrontComponentTarget[]; settings: PluginSettingsSchema }>;
  islands: string[];
  stylesheet: boolean;
  connect: string[];
}

/**
 * The settings schema of each active app surface (a component section, a
 * skin, a component) by its `<plugin id>/<id>` theme key: what the theme's
 * translated text reads to know which values are words (`text`, `textarea`).
 */
export function storefrontExtensionSettingSchemas(extensions: readonly StorefrontExtension[]): (kind: "section" | "skin" | "component", key: string) => PluginSettingsSchema | null {
  const schemas = new Map<string, PluginSettingsSchema>();
  for (const extension of extensions) {
    for (const [type, schema] of Object.entries(extension.sectionSettings)) schemas.set(`section:${extension.pluginId}/${type}`, schema);
    for (const skin of extension.skins) schemas.set(`skin:${extension.pluginId}/${skin.id}`, skin.settings);
    for (const component of extension.components) schemas.set(`component:${extension.pluginId}/${component.type}`, component.settings);
  }
  return (kind, key) => schemas.get(`${kind}:${key}`) ?? null;
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
    const names = (list: unknown, pattern: RegExp) => Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && pattern.test(name)) : [];
    const skins = Array.isArray(item.skins) ? item.skins.flatMap((skin) => {
      if (typeof skin !== "object" || skin === null) return [];
      const record = skin as Record<string, unknown>;
      if (typeof record.id !== "string" || !PLUGIN_KEY_PATTERN.test(record.id) || !isStorefrontSkinTarget(record.target)) return [];
      const settings = pluginSettingsSchemaSchema.safeParse(record.settings ?? []);
      return settings.success ? [{ id: record.id, target: record.target, settings: settings.data }] : [];
    }) : [];
    const components = Array.isArray(item.components) ? item.components.flatMap((component) => {
      if (typeof component !== "object" || component === null) return [];
      const record = component as Record<string, unknown>;
      if (typeof record.type !== "string" || !PLUGIN_KEY_PATTERN.test(record.type) || !Array.isArray(record.targets)) return [];
      const targets = record.targets.filter((target): target is StorefrontComponentTarget => (STOREFRONT_COMPONENT_TARGETS as readonly unknown[]).includes(target));
      const settings = pluginSettingsSchemaSchema.safeParse(record.settings ?? []);
      return settings.success && targets.length > 0 ? [{ type: record.type, targets, settings: settings.data }] : [];
    }) : [];
    const sectionSettings: Record<string, PluginSettingsSchema> = {};
    if (typeof item.sectionSettings === "object" && item.sectionSettings !== null) {
      for (const [type, schema] of Object.entries(item.sectionSettings as Record<string, unknown>)) {
        if (!PLUGIN_KEY_PATTERN.test(type)) continue;
        const parsed = pluginSettingsSchemaSchema.safeParse(schema);
        if (parsed.success) sectionSettings[type] = parsed.data;
      }
    }
    out.push({
      pluginId: item.pluginId,
      version: item.version,
      source: item.source,
      release: item.release,
      sections: names(item.sections, PLUGIN_KEY_PATTERN),
      sectionSettings,
      skins,
      components,
      islands: names(item.islands, PLUGIN_URL_NAME_PATTERN),
      stylesheet: item.stylesheet === true,
      connect: Array.isArray(item.connect) ? item.connect.filter((host): host is string => typeof host === "string" && HOST.test(host)) : [],
    });
  }
  return out;
}

