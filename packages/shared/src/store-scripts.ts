/**
 * The store's own scripts (Settings → Analytics: GA4, Tag Manager, Meta,
 * TikTok, Cloudflare and custom snippets) as the storefront's
 * Content-Security-Policy and its Partytown proxy read them, and as the API
 * checks them when one is saved: one reading, so what a merchant may save is
 * exactly what can run.
 *
 * - Each inline script of a snippet runs by its SHA-256 hash.
 * - The hosts a snippet loads from are the https origins its own `src`
 *   attributes name, each one a plain host: no wildcard, comma, semicolon,
 *   quote, space or control character can reach the policy header.
 * - A store's snippets together stay within fixed limits, so the policy
 *   header stays small and whole; the API refuses a snippet past them.
 */
import { htmlScriptBlocks, isRunnableScriptType } from "./http-security";
import { normalizePlatformOrigin } from "./security-csp";

/** One saved script, as the layout carries it. */
export interface StoreScript {
  type: string;
  config: string;
  usePartytown?: boolean;
}

/** What one snippet needs from the page policy. */
export interface SnippetSources {
  /** The bodies of its inline scripts (hashed by the caller). */
  inline: string[];
  script: string[];
  img: string[];
  frame: string[];
  /** Absolute script, image or frame addresses that are not a plain https host: never allowed. */
  refused: string[];
}

/**
 * Limits for a store's snippets together: each snippet and the store's whole
 * set. They keep the page policy header within a few kilobytes.
 */
export const STORE_SCRIPT_LIMITS = {
  originsPerSnippet: 8,
  inlineScriptsPerSnippet: 16,
  origins: 32,
  inlineScripts: 64,
} as const;

// A DNS name of letters, digits and hyphens: nothing a header could split on.
const HOST_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;

/**
 * The https origin a snippet's address names, or null when it is not a plain
 * https host: `*`, a comma, a semicolon, a quote, whitespace or a control
 * character anywhere makes it null.
 */
export function snippetOrigin(value: string): string | null {
  const raw = value.trim();
  if (!raw || /[\s,;'"*\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const origin = normalizePlatformOrigin(url.origin);
  return origin && HOST_ORIGIN.test(origin) ? origin : null;
}

/** Whether an address is relative to the page (the store's own origin). */
function isRelative(value: string): boolean {
  const raw = value.trim();
  return !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//");
}

const URL_ATTRIBUTE = /<(img|iframe)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** A script's real type: a consent-gated one keeps it in `data-scalius-type`. */
function scriptType(attributes: ReadonlyMap<string, string>): string | undefined {
  return attributes.get("data-scalius-type") ?? attributes.get("type");
}

/**
 * What one snippet needs: its runnable inline scripts (a Partytown or data
 * block runs nowhere on the page and needs none), and the origins its own
 * script, image and frame addresses name.
 */
export function snippetSources(config: string): SnippetSources {
  const sources: SnippetSources = { inline: [], script: [], img: [], frame: [], refused: [] };
  const add = (list: string[], value: string) => {
    if (isRelative(value)) return;
    const origin = snippetOrigin(value);
    if (origin) {
      if (!list.includes(origin)) list.push(origin);
    } else sources.refused.push(value.slice(0, 200));
  };
  for (const block of htmlScriptBlocks(config)) {
    if (!isRunnableScriptType(scriptType(block.attributes))) continue;
    const src = block.attributes.get("src");
    if (src === undefined) sources.inline.push(block.body);
    else add(sources.script, src);
  }
  for (const match of config.matchAll(URL_ATTRIBUTE)) {
    add(match[1]!.toLowerCase() === "img" ? sources.img : sources.frame, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return sources;
}

/** Why a snippet cannot be saved as it is. */
export type SnippetProblem =
  | { kind: "address"; value: string }
  | { kind: "too_many_hosts"; limit: number }
  | { kind: "too_many_scripts"; limit: number }
  | { kind: "store_limit" };

const originCount = (sources: SnippetSources) => new Set([...sources.script, ...sources.img, ...sources.frame]).size;

/**
 * The problems of one snippet in the store's set (`others`: the store's
 * other active snippets). Empty when it can run as saved.
 */
export function snippetProblems(config: string, others: readonly string[] = []): SnippetProblem[] {
  const sources = snippetSources(config);
  const problems: SnippetProblem[] = sources.refused.map((value) => ({ kind: "address", value }));
  if (originCount(sources) > STORE_SCRIPT_LIMITS.originsPerSnippet) problems.push({ kind: "too_many_hosts", limit: STORE_SCRIPT_LIMITS.originsPerSnippet });
  if (sources.inline.length > STORE_SCRIPT_LIMITS.inlineScriptsPerSnippet) problems.push({ kind: "too_many_scripts", limit: STORE_SCRIPT_LIMITS.inlineScriptsPerSnippet });
  if (problems.length === 0 && boundStoreScripts([...others, config].map((text) => snippetSources(text))).dropped.includes(others.length)) {
    problems.push({ kind: "store_limit" });
  }
  return problems;
}

/**
 * The store's snippets within the limits, in order: a snippet that breaks a
 * per-snippet limit, or would take the set past a store limit, is dropped
 * whole (its scripts do not run; the API refuses to save it). `dropped`
 * names the dropped snippets' positions.
 */
export function boundStoreScripts(snippets: readonly SnippetSources[]): { kept: SnippetSources[]; dropped: number[] } {
  const kept: SnippetSources[] = [];
  const dropped: number[] = [];
  const origins = new Set<string>();
  let inline = 0;
  snippets.forEach((sources, index) => {
    const own = [...sources.script, ...sources.img, ...sources.frame];
    const added = own.filter((origin) => !origins.has(origin));
    if (
      originCount(sources) > STORE_SCRIPT_LIMITS.originsPerSnippet
      || sources.inline.length > STORE_SCRIPT_LIMITS.inlineScriptsPerSnippet
      || origins.size + new Set(added).size > STORE_SCRIPT_LIMITS.origins
      || inline + sources.inline.length > STORE_SCRIPT_LIMITS.inlineScripts
    ) {
      dropped.push(index);
      return;
    }
    for (const origin of added) origins.add(origin);
    inline += sources.inline.length;
    kept.push(sources);
  });
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// The tags' ids, for the Partytown proxy: it fetches a tag only for the
// container, measurement or pixel id the store's own scripts name.
// ---------------------------------------------------------------------------

export interface StoreTagIds {
  /** GTM-… containers. */
  containers: Set<string>;
  /** G-…, AW-…, GT-…, DC-… tag ids named in a snippet. */
  googleTags: Set<string>;
  metaPixels: Set<string>;
  tiktokPixels: Set<string>;
}

const GOOGLE_TAG = /\b(?:G|AW|GT|DC)-[A-Z0-9]{4,32}\b/gi;
const CONTAINER = /\bGTM-[A-Z0-9]{4,32}\b/gi;
const META_PIXEL = /\bfbq\s*\(\s*(['"])init\1\s*,\s*(['"])(\d{5,32})\2/gi;
const TIKTOK_PIXEL = /\bttq\.load\s*\(\s*(['"])([A-Z0-9_-]{6,64})\1|\bsdkid=([A-Z0-9_-]{6,64})\b/gi;

/** The ids the given scripts name. */
export function storeTagIds(scripts: readonly StoreScript[]): StoreTagIds {
  const ids: StoreTagIds = { containers: new Set(), googleTags: new Set(), metaPixels: new Set(), tiktokPixels: new Set() };
  for (const { config } of scripts) {
    for (const match of config.matchAll(CONTAINER)) ids.containers.add(match[0].toUpperCase());
    for (const match of config.matchAll(GOOGLE_TAG)) ids.googleTags.add(match[0].toUpperCase());
    for (const match of config.matchAll(META_PIXEL)) ids.metaPixels.add(match[3]!);
    for (const match of config.matchAll(TIKTOK_PIXEL)) ids.tiktokPixels.add((match[2] ?? match[3])!.toUpperCase());
  }
  return ids;
}

const id = (url: URL, name: string) => (url.searchParams.get(name) ?? "").toUpperCase();

/**
 * Whether the Partytown proxy may fetch this tag URL for a store whose
 * scripts that run in Partytown are `scripts` (the proxy checks the host and
 * path first). A container or pixel is only ever one the store names; a
 * Google tag a store's own container loads (its GA4 or Ads tag, configured
 * inside the container) is any well-formed tag id once the store runs a
 * container.
 */
export function partytownTagAllowed(url: URL, scripts: readonly StoreScript[]): boolean {
  const ids = storeTagIds(scripts.filter((script) => script.usePartytown === true));
  switch (url.hostname) {
    case "www.googletagmanager.com": {
      if (url.pathname === "/gtm.js") return ids.containers.has(id(url, "id"));
      const tag = id(url, "id");
      return ids.googleTags.has(tag) || (ids.containers.size > 0 && /^(?:G|AW|GT|DC)-[A-Z0-9]{4,32}$/.test(tag));
    }
    case "www.google-analytics.com":
      return ids.googleTags.size > 0 || ids.containers.size > 0;
    case "connect.facebook.net": {
      const config = /^\/signals\/config\/(\d{1,32})$/.exec(url.pathname);
      return ids.metaPixels.size > 0 && (!config || ids.metaPixels.has(config[1]!));
    }
    case "analytics.tiktok.com": {
      const sdk = id(url, "sdkid");
      return ids.tiktokPixels.size > 0 && (!sdk || ids.tiktokPixels.has(sdk));
    }
    default:
      return false;
  }
}
