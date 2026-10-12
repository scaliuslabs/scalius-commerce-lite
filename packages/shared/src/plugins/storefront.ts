// Storefront surfaces of a plugin (docs/platform/PLUGINS.md, "Storefront
// surfaces"): theme sections, product blocks, checkout and customer-account
// blocks, head tags and proxy pages.
// Each is answered by one of the app's public routes:
//
// - a section or product block route gets `request.render` (what to draw,
//   with the merchant's settings) and answers `{ html, head? }`. The API
//   sanitizes the HTML (html.ts) and stores it inside the homepage or
//   product-apps batch part under dependency validation, so a cache hit runs
//   no plugin code. While rendering, a plugin may read only its own settings
//   and the storage collections the section declares in `reads`;
// - a proxy page (`/apps/<id>/<route>`, a browser navigation) answers
//   `{ page: { title, html, … } }` and is drawn inside the store layout, or
//   `{ redirect: "/same/store/path" }` after a form post.
//
// Part of the versioned plugin API.

import { z } from "zod";
import type { PluginSettingValue } from "./settings-schema";

/**
 * At most this many app sections render on one page (a page's whole section
 * cap): component sections draw at the edge from the page's own data.
 */
export const PLUGIN_HOME_SECTIONS_MAX = 24;
/** Of them, at most this many route sections (each a call to its app); later ones render nothing. */
export const PLUGIN_HOME_ROUTE_SECTIONS_MAX = 8;
/** At most this many app blocks render on one product page. */
export const PLUGIN_PRODUCT_BLOCKS_MAX = 10;
/** A storefront render shares the page's time: its wall time is capped below the manifest's. */
export const PLUGIN_RENDER_WALL_MS = 1_500;
/** A failed render is retried after this long (the page stays cacheable meanwhile). */
export const PLUGIN_RENDER_RETRY_SECONDS = 60;
/** App sections and blocks rendered at once. */
export const PLUGIN_RENDER_CONCURRENCY = 4;

/** `<plugin id>/<section or block type>`: how a theme names an app's section or block. */
export const PLUGIN_SURFACE_KEY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)\/([a-z][a-z0-9-]{0,47})$/;

export function pluginSurfaceKey(pluginId: string, type: string): string {
  return `${pluginId}/${type}`;
}

export function parsePluginSurfaceKey(key: string): { pluginId: string; type: string } | null {
  const match = PLUGIN_SURFACE_KEY_PATTERN.exec(key);
  return match ? { pluginId: match[1]!, type: match[2]! } : null;
}

// ── Checkout and customer-account blocks ─────────────────────────────────

/**
 * Where an app block draws, by Shopify's extension target names (checkout
 * and customer-account UI extensions). A block is the same for every buyer:
 * it is drawn once from the app's settings and declared collections, cached
 * under dependency validation and served as plain sanitized HTML, so the
 * page stays usable before hydration and without JavaScript. Never per-buyer
 * data, never app JavaScript.
 */
export const PLUGIN_BLOCK_TARGETS = [
  // Checkout: the information step (cart page) and the payment step.
  "purchase.checkout.contact.render-after",
  "purchase.checkout.shipping-option-list.render-after",
  "purchase.checkout.cart-line-list.render-after",
  "purchase.checkout.payment-method-list.render-after",
  "purchase.checkout.actions.render-before",
  // The thank-you page.
  "purchase.thank-you.customer-information.render-after",
  // Customer accounts: the order status page, the orders list and the profile.
  "customer-account.order-status.block.render",
  "customer-account.order-index.block.render",
  "customer-account.profile.block.render",
] as const;
export type PluginBlockTarget = (typeof PLUGIN_BLOCK_TARGETS)[number];

/** The storefront page groups whose batch reads one blocks part each. */
export const PLUGIN_BLOCK_PAGES = ["checkout", "order", "account"] as const;
export type PluginBlockPage = (typeof PLUGIN_BLOCK_PAGES)[number];

/** The page group a target draws on. */
export function pluginBlockPage(target: PluginBlockTarget): PluginBlockPage {
  if (target.startsWith("purchase.checkout.")) return "checkout";
  if (target === "purchase.thank-you.customer-information.render-after" || target === "customer-account.order-status.block.render") return "order";
  return "account";
}

/**
 * Targets inside the checkout form: their HTML may hold no form of its own
 * (a nested form would break the buyer's), so forms are dropped there.
 */
export function pluginBlockAllowsForms(target: PluginBlockTarget): boolean {
  return pluginBlockPage(target) !== "checkout";
}

/** At most this many app blocks draw on one page group. */
export const PLUGIN_PAGE_BLOCKS_MAX = 12;

/** What a section, product block or checkout/account block route is asked to draw (`request.render`). */
export interface PluginRenderContext {
  kind: "section" | "product-block" | "block";
  /** Checkout and customer-account blocks: where it draws. */
  target?: PluginBlockTarget;
  /** The manifest section or block type. */
  type: string;
  /** The theme's id of this placement (stable while the merchant keeps it). */
  instanceId: string;
  /** The merchant's settings for this placement, resolved against the manifest (defaults filled). */
  settings: Record<string, PluginSettingValue>;
  /** Product blocks: the product the page shows. */
  product: { id: string; slug: string; categoryId: string | null; brandId: string | null } | null;
}

// ── Head contributions ────────────────────────────────────────────────────

/** Meta names the page owns (or that change how the page is indexed or shown). */
const RESERVED_META_NAMES = new Set([
  "robots", "googlebot", "bingbot", "viewport", "referrer", "description", "theme-color", "color-scheme",
  "generator", "application-name", "keywords", "author", "format-detection",
]);
const META_NAME = /^[a-z][a-z0-9:._-]{0,63}$/;
/** `og:` and `twitter:` belong to the page; apps may add product facts and their own verification tags. */
const META_PROPERTY = /^(?:product|article|fb|al):[a-z0-9:._-]{1,60}$/;
export const PLUGIN_HEAD_LIMITS = { meta: 10, jsonLd: 3, jsonLdBytes: 16 * 1024, content: 500 } as const;

export const pluginHeadSchema = z.object({
  meta: z.array(z.object({
    name: z.string().optional(),
    property: z.string().optional(),
    content: z.string().max(PLUGIN_HEAD_LIMITS.content),
  }).strict()).max(PLUGIN_HEAD_LIMITS.meta).optional(),
  jsonLd: z.array(z.record(z.string(), z.unknown())).max(PLUGIN_HEAD_LIMITS.jsonLd).optional(),
}).strict();
export type PluginHeadInput = z.infer<typeof pluginHeadSchema>;

/** Head tags ready to render: meta pairs and JSON-LD already serialized for a `<script type="application/ld+json">`. */
export interface PluginHead {
  meta: Array<{ attribute: "name" | "property"; key: string; content: string }>;
  jsonLd: string[];
}

export const EMPTY_PLUGIN_HEAD: Readonly<PluginHead> = Object.freeze({ meta: [], jsonLd: [] });

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the element or start markup. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

function plainContent(value: string): string {
  let text = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    text += code < 0x20 || code === 0x7f ? " " : character;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Keeps the head tags an app may add: meta tags whose name the page does not
 * own (no robots, viewport, description, og: or twitter:), plain-text
 * content; schema.org JSON-LD objects, bounded. Anything else is dropped.
 */
export function sanitizePluginHead(value: unknown): PluginHead {
  const parsed = pluginHeadSchema.safeParse(value);
  if (!parsed.success) return { meta: [], jsonLd: [] };
  const meta: PluginHead["meta"] = [];
  for (const entry of parsed.data.meta ?? []) {
    const content = plainContent(entry.content);
    if (!content) continue;
    if (entry.name !== undefined && entry.property === undefined) {
      const key = entry.name.toLowerCase();
      if (META_NAME.test(key) && !RESERVED_META_NAMES.has(key) && !key.startsWith("og:") && !key.startsWith("twitter:")) {
        meta.push({ attribute: "name", key, content });
      }
    } else if (entry.property !== undefined && entry.name === undefined) {
      const key = entry.property.toLowerCase();
      if (META_PROPERTY.test(key)) meta.push({ attribute: "property", key, content });
    }
  }
  const jsonLd: string[] = [];
  for (const entry of parsed.data.jsonLd ?? []) {
    const context = entry["@context"];
    if (context !== "https://schema.org" && context !== "http://schema.org" && context !== "https://schema.org/") continue;
    if (typeof entry["@type"] !== "string" || !/^[A-Za-z]{2,60}$/.test(entry["@type"])) continue;
    let serialized: string;
    try {
      serialized = serializeJsonLd({ ...entry, "@context": "https://schema.org" });
    } catch {
      continue;
    }
    if (new TextEncoder().encode(serialized).byteLength > PLUGIN_HEAD_LIMITS.jsonLdBytes) continue;
    jsonLd.push(serialized);
  }
  return { meta, jsonLd };
}

// ── What a section or block route answers ────────────────────────────────

export const pluginRenderOutputSchema = z.object({
  html: z.string(),
  head: z.unknown().optional(),
}).strict();
export type PluginRenderOutput = z.infer<typeof pluginRenderOutputSchema>;

// ── Proxy pages ──────────────────────────────────────────────────────────

/** A same-store path to send the browser to (`/apps/<id>/thanks`, `/products/x`), never another origin. */
export const pluginRedirectPathSchema = z.string().max(600).regex(/^\/(?![/\\])[^\s\\]*$/, "Use a path on this store.");

export const pluginPageOutputSchema = z.union([
  z.object({
    page: z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(300).optional(),
      html: z.string(),
      head: z.unknown().optional(),
      /** Proxy pages are `noindex` unless the app says the page is public content. */
      index: z.boolean().optional(),
    }).strict(),
  }).strict(),
  z.object({ redirect: pluginRedirectPathSchema }).strict(),
]);
export type PluginPageOutput = z.infer<typeof pluginPageOutputSchema>;

/** What a proxied route answered: a page to draw in the store layout, a redirect, or plain JSON (null here). */
export function parsePluginPageOutput(value: unknown): PluginPageOutput | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("page" in value) && !("redirect" in value)) return null;
  const parsed = pluginPageOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
