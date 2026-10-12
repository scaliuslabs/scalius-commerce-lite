/**
 * What installed apps draw on the storefront (docs/platform: "Storefront
 * surfaces"): homepage sections (inside the homepage batch part), product
 * blocks (the `product-apps` batch part) and their head tags, and checkout
 * and customer-account blocks (the `app-blocks/<page>` batch part, read only
 * when the layout's `appBlockPages` names the page).
 *
 * The API asks each app to draw, sanitizes the HTML (`sanitizePluginHtml`)
 * and the head tags (`sanitizePluginHead`) and caches the result under
 * dependency validation. The storefront does not sanitize that HTML again; it
 * only checks the payload's shape, so nothing that did not come from those
 * fields is ever injected, and a surface without HTML renders nothing.
 */
import {
  PLUGIN_BLOCK_PAGES,
  PLUGIN_BLOCK_TARGETS,
  PLUGIN_SURFACE_KEY_PATTERN,
  type PluginBlockPage,
  type PluginBlockTarget,
  type PluginHead,
} from "@scalius/shared/plugins/storefront";

/**
 * A component section's data (docs/STOREFRONT-COMPONENTS.md): the app's
 * storefront module draws it here, at the edge, from these values and the
 * images and product cards its settings name.
 */
export interface HomepageAppComponent {
  pluginId: string;
  type: string;
  values: Record<string, unknown>;
  media: Array<{ id: string; url: string; alt: string; width: number | null; height: number | null }>;
  lists: Array<{ source: string; products: unknown[] }>;
}

/** One homepage app section, keyed by its theme section id: drawn HTML, or a component section's data. */
export interface HomepageAppSurface {
  sectionId: string;
  html: string;
  head: PluginHead;
  component?: HomepageAppComponent;
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const TYPE = /^[a-z][a-z0-9-]{0,47}$/;

/** A component section's data, shape-checked; null when it is not one. */
export function readAppComponent(value: unknown): HomepageAppComponent | null {
  if (!isRecord(value) || typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) return null;
  if (typeof value.type !== "string" || !TYPE.test(value.type) || !isRecord(value.values)) return null;
  const media = (Array.isArray(value.media) ? value.media : []).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.url !== "string" || !/^https:\/\/|^\//.test(entry.url)) return [];
    const size = (input: unknown) => (typeof input === "number" && Number.isFinite(input) && input > 0 ? input : null);
    return [{ id: entry.id, url: entry.url, alt: typeof entry.alt === "string" ? entry.alt : "", width: size(entry.width), height: size(entry.height) }];
  });
  const lists = (Array.isArray(value.lists) ? value.lists : []).flatMap((entry) => (
    isRecord(entry) && typeof entry.source === "string" && Array.isArray(entry.products)
      ? [{ source: entry.source, products: entry.products as unknown[] }]
      : []
  ));
  return { pluginId: value.pluginId, type: value.type, values: value.values, media, lists };
}

/** One drawn product block, in the merchant's order; its app decides where it goes. */
export interface ProductAppBlock {
  id: string;
  /** `<plugin id>/<type>`. */
  app: string;
  placement: "buy-box" | "below";
  html: string;
  head: PluginHead;
}

const META_KEY = /^[a-z][a-z0-9:._-]{0,63}$/;
/** Theme section and product block ids. */
const SURFACE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Head tags as the API serialized them. A JSON-LD string can never close its
 * script element: the API escapes `<`, so a string that still has one is
 * dropped rather than trusted.
 */
export function readAppHead(value: unknown): PluginHead {
  if (!isRecord(value)) return { meta: [], jsonLd: [] };
  const meta = (Array.isArray(value.meta) ? value.meta : []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { attribute, key, content } = entry;
    if ((attribute !== "name" && attribute !== "property") || typeof key !== "string" || !META_KEY.test(key)) return [];
    if (typeof content !== "string" || !content.trim() || content.length > 500) return [];
    return [{ attribute, key, content } as PluginHead["meta"][number]];
  });
  const jsonLd = (Array.isArray(value.jsonLd) ? value.jsonLd : []).filter(
    (entry): entry is string => typeof entry === "string" && entry.startsWith("{") && !entry.includes("<"),
  );
  return { meta, jsonLd };
}

function drawnHtml(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The homepage's drawn app sections (`sections.apps`) by section id; ones without HTML are left out. */
export function readHomepageAppSurfaces(value: unknown): Map<string, HomepageAppSurface> {
  const surfaces = new Map<string, HomepageAppSurface>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry) || typeof entry.sectionId !== "string" || !SURFACE_ID.test(entry.sectionId)) continue;
    if (surfaces.has(entry.sectionId)) continue;
    const component = readAppComponent(entry.component);
    if (component) {
      surfaces.set(entry.sectionId, { sectionId: entry.sectionId, html: "", head: readAppHead(entry.head), component });
      continue;
    }
    const html = drawnHtml(entry.html);
    if (!html) continue;
    surfaces.set(entry.sectionId, { sectionId: entry.sectionId, html, head: readAppHead(entry.head) });
  }
  return surfaces;
}

/** A product page's drawn app blocks (`blocks`), in order; ones without HTML are left out. */
export function readProductAppBlocks(value: unknown): ProductAppBlock[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !SURFACE_ID.test(entry.id) || seen.has(entry.id)) return [];
    if (typeof entry.app !== "string" || !PLUGIN_SURFACE_KEY_PATTERN.test(entry.app)) return [];
    if (entry.placement !== "buy-box" && entry.placement !== "below") return [];
    const html = drawnHtml(entry.html);
    if (!html) return [];
    seen.add(entry.id);
    return [{ id: entry.id, app: entry.app, placement: entry.placement, html, head: readAppHead(entry.head) }];
  });
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

/** One drawn checkout or customer-account block. */
export interface AppBlock {
  /** `<plugin id>/<block type>`. */
  id: string;
  target: PluginBlockTarget;
  html: string;
}

/** A page group's drawn blocks (`blocks`), in order; unknown targets and ones without HTML are left out. */
export function readAppBlocks(value: unknown): AppBlock[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !PLUGIN_SURFACE_KEY_PATTERN.test(entry.id) || seen.has(entry.id)) return [];
    if (typeof entry.target !== "string" || !(PLUGIN_BLOCK_TARGETS as readonly string[]).includes(entry.target)) return [];
    const html = drawnHtml(entry.html);
    if (!html) return [];
    seen.add(entry.id);
    return [{ id: entry.id, target: entry.target as PluginBlockTarget, html }];
  });
}

/** Whether the layout says an active app draws blocks on this page group (absent: none). */
export function layoutHasAppBlocks(layout: { appBlockPages?: unknown } | null | undefined, page: PluginBlockPage): boolean {
  return Array.isArray(layout?.appBlockPages)
    && (PLUGIN_BLOCK_PAGES as readonly string[]).includes(page)
    && layout.appBlockPages.includes(page);
}
