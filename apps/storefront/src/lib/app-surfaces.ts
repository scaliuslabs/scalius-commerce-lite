/**
 * What installed apps give the storefront to draw (docs/platform: "Storefront
 * surfaces"): component sections (inside the homepage batch part, drawn at the
 * edge by the app's storefront module), and checkout and customer-account
 * blocks (the `app-blocks/<page>` batch part, read only when the layout's
 * `appBlockPages` names the page).
 *
 * The API sanitizes a block's HTML (`sanitizePluginHtml`) and caches the
 * result under dependency validation. The storefront does not sanitize that
 * HTML again; it only checks the payload's shape, so nothing that did not
 * come from those fields is ever injected, and a surface without HTML renders
 * nothing.
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
  return { pluginId: value.pluginId, type: value.type, values: value.values, media, lists };
}

/** Theme section ids. */
const SURFACE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function drawnHtml(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
