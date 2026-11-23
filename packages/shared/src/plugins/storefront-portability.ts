// What `pnpm plugin validate` tells a developer about a theme that only works
// on the store it was built on (packages/plugin-sdk/docs/themes.md). Every
// value an app ships for the storefront (its templates, page presets and the
// defaults of its section, component and skin settings) lands unchanged in
// every store that installs it, so:
//
// - a literal `/products/<slug>`, `/categories/<slug>` or `/collections/<id>`
//   names the developer's own catalogue: a dead link everywhere else;
// - a page path that is not a core route (`/support`, `/free-games`) exists
//   only once a merchant makes that page;
// - `custom.<key>` is the merchant's own field namespace: no other store has it;
// - the app's own name written as shop copy shows on every store as if it
//   were the store's;
// - bundled artwork is downloaded by every store, and a file named after a
//   third-party mark (a game, console, publisher or brand) is a licence the
//   developer must hold for every merchant.
//
// These are checks of declared data only: nothing here runs the app's code.
// A note is `fail` where the value is broken on any store but the
// developer's, `warn` where it depends on the store or on a judgement.

import type { PluginManifest } from "./manifest";

export type StorefrontPortabilityRule =
  | "catalog_link"
  | "page_link"
  | "header_link"
  | "merchant_field"
  | "fixed_identity"
  | "artwork_size"
  | "artwork_mark";

export interface StorefrontPortabilityNote {
  level: "fail" | "warn";
  rule: StorefrontPortabilityRule;
  /** Where the value is: `template gaming, section gaming-hero`, `skin gg_header setting links`, `public/artwork/gta.jpg`. */
  where: string;
  message: string;
}

/** The core routes every store has, by their first path segment (`/account/orders` is under `account`). */
export const STOREFRONT_CORE_ROUTE_SEGMENTS = [
  "search", "cart", "checkout", "account", "categories", "collections", "blog",
  "track-order", "compare", "gift-card-balance", "newsletter",
] as const;
/** Core routes that are a listing at their first segment only: a second segment names one store's record. */
const RECORD_ROUTES = new Set(["categories", "collections", "blog"]);
const CORE_ROUTES = new Set<string>(STOREFRONT_CORE_ROUTE_SEGMENTS);
const CORE_ROUTES_SHOWN = "/, /search, /cart, /account, /categories, /collections, /blog, /track-order";

/** Bundled images above this many bytes warn: every store downloads them, and a merchant's own image setting is usually better. */
export const STOREFRONT_ARTWORK_WARN_BYTES = 200 * 1024;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif|svg)$/i;

/**
 * Words in a file name that suggest a third-party mark: games, consoles,
 * publishers, stores, and widely known brands. A name is not proof either
 * way; this only asks the developer to check the licence.
 */
const THIRD_PARTY_MARKS: readonly string[] = [
  // Games and their publishers, consoles and stores.
  "gta", "grand theft auto", "rockstar", "rockstargames", "playstation", "ps4", "ps5", "xbox", "nintendo",
  "steam", "epicgames", "epic games", "ubisoft", "ea", "battlenet", "battledotnet", "battle net", "blizzard",
  "minecraft", "roblox", "pubg", "fortnite", "valorant", "witcher", "cyberpunk", "resident evil", "capcom",
  "free fire", "freefire", "mobile legends", "call of duty", "cod mobile", "fifa", "pokemon", "zelda",
  "max payne", "san andreas", "terraria", "stardew", "dead cells",
  // Media, technology and consumer brands (not words a shop uses for its own goods, such as "apple").
  "netflix", "spotify", "disney", "marvel", "youtube", "iphone", "google", "android", "microsoft",
  "sony", "samsung", "amazon", "nike", "adidas", "gucci", "louis vuitton", "coca cola", "cocacola",
  "pepsi", "visa", "mastercard", "paypal",
];
const MARK_TOKENS = THIRD_PARTY_MARKS.map((mark) => ({ mark, tokens: mark.split(" ") }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A same-store path: `/`, `/x`, `/x?y`, never `//host` or text with spaces. */
function isStorePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !/\s/.test(value) && value.length <= 2048;
}

/** Where a value sits, which decides how a link in it is resolved. */
interface Place {
  where: string;
  /** A homepage section of a template or a page preset's section: handle links resolve, and a missing one drops the section. */
  section: boolean;
  /** The header: its links should come from the store's menu. */
  header: boolean;
  /** A setting default: used as written on every store, nothing resolves. */
  default: boolean;
}

function linkNote(path: string, place: Place, appId: string): Omit<StorefrontPortabilityNote, "where"> | null {
  const pathname = path.split(/[?#]/, 1)[0]!;
  const segments = pathname.split("/").filter(Boolean);
  const [first, second] = segments;
  if (!first) return null;
  const leaveForMerchant = place.header
    ? "Ship the header's link list empty and draw the store's own menu (data.menu, data.categories): the merchant edits it under Online store, Navigation."
    : "Leave the link empty so the merchant chooses it.";
  if (first === "products" && second) {
    return {
      level: "fail",
      rule: "catalog_link",
      message: `links ${path}, a product only your store sells: on every other store it is a dead link. Products differ per store: use a products or product setting, or a product source such as { "kind": "newest" } or { "kind": "category", "handle": "pc-games" }, and link each card's own url. Never pair bundled artwork with a product path.`,
    };
  }
  if ((first === "categories" || first === "collections") && second) {
    const kind = first === "categories" ? "category" : "collection";
    if (second.startsWith("@")) {
      if (place.section) return null;
      return {
        level: "fail",
        rule: "catalog_link",
        message: place.default
          ? `links ${path}: handle links resolve only in a template's or page preset's sections, so this default stays a dead link on every store. ${leaveForMerchant}`
          : `links ${path} outside the template's homepage sections: a store without that ${kind} cannot use the template at all. Move the link into a section (one missing ${kind} then drops only that section). ${leaveForMerchant}`,
      };
    }
    return {
      level: "fail",
      rule: "catalog_link",
      message: place.section
        ? `links ${path}, a ${kind} of your store: elsewhere it is a dead link. Write /${first}/@${kind === "category" ? second : "<collection handle>"}: the store resolves the handle and leaves the section out where no such ${kind} exists.`
        : `links ${path}, a ${kind} of your store: on every other store it is a dead link. ${leaveForMerchant}`,
    };
  }
  if (first === "apps") {
    if (second === appId) return null;
    return { level: "warn", rule: place.header ? "header_link" : "page_link", message: `links ${path}, another app's page: it works only where that app is installed. ${leaveForMerchant}` };
  }
  if (CORE_ROUTES.has(first) && !(second && RECORD_ROUTES.has(first))) return null;
  if (first === "blog" || first === "brands") {
    return {
      level: "warn",
      rule: place.header ? "header_link" : "page_link",
      message: `links ${path}, ${first === "blog" ? "an article" : "a brand"} of your store: a dead link on stores without it. ${leaveForMerchant}`,
    };
  }
  return {
    level: "warn",
    rule: place.header ? "header_link" : "page_link",
    message: `links ${path}, a page your store has and a new store does not (a dead link until the merchant makes it). The routes every store has are ${CORE_ROUTES_SHOWN}. ${leaveForMerchant} If your theme needs a page, say in its listing which page to create.`,
  };
}

/** `custom.<key>` references in a value: card fields, bindings (`resource.cf.custom.<key>`), merchant objects (`object.custom.<type>…`). */
const MERCHANT_REFERENCE = /(?:^|\.)custom\.([a-z][a-z0-9_]*)/;

function merchantFieldNote(value: string, appId: string): Omit<StorefrontPortabilityNote, "where"> | null {
  const match = MERCHANT_REFERENCE.exec(value);
  if (!match) return null;
  return {
    level: "warn",
    rule: "merchant_field",
    message: `uses ${value}: custom.* is the merchant's own namespace, so no other store has custom.${match[1]}. Declare the field in customFields, name it ${appId}.${match[1]} and write its values with ctx.customFields, or leave it out and let the merchant choose fields in the theme editor.`,
  };
}

function identityNote(value: string, appName: string): Omit<StorefrontPortabilityNote, "where"> | null {
  const name = appName.trim().toLowerCase();
  const text = value.trim().toLowerCase();
  // Shop copy only: ids, keys and paths (`acme.tally/banner`) have no spaces.
  const prose = /\s/.test(text) || text === name;
  if (name.length < 3 || !prose || isStorePath(value) || !text.includes(name)) return null;
  return {
    level: "warn",
    rule: "fixed_identity",
    message: `says "${appName.trim()}", your app's name, as shop copy: on every store that installs it, buyers read your name instead of the store's. Draw data.store.name or data.store.logo (header and footer projections), or leave the text empty for the merchant.`,
  };
}

/** The value's strings with where they sit; `skip` leaves out a path (template card fields have their own check). */
function eachString(value: unknown, visit: (text: string) => void, skip?: (path: readonly string[]) => boolean, path: string[] = []): void {
  if (skip?.(path)) return;
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((item, index) => eachString(item, visit, skip, [...path, String(index)]));
  else if (isRecord(value)) for (const [key, child] of Object.entries(value)) eachString(child, visit, skip, [...path, key]);
}

type PortabilityManifest = Pick<PluginManifest, "id" | "name"> & {
  storefront: Pick<PluginManifest["storefront"], "sections" | "components" | "skins" | "templates" | "pagePresets">;
};

/**
 * The portability notes for a manifest's storefront declarations, and for
 * its public files when given (`path` inside `public/`, `bytes` their size).
 */
export function storefrontPortabilityNotes(
  manifest: PortabilityManifest,
  options: { publicFiles?: ReadonlyArray<{ path: string; bytes: number }> } = {},
): StorefrontPortabilityNote[] {
  const notes: StorefrontPortabilityNote[] = [];
  const seen = new Set<string>();
  const add = (where: string, note: Omit<StorefrontPortabilityNote, "where"> | null) => {
    if (!note) return;
    const key = `${where}\u0000${note.rule}\u0000${note.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    notes.push({ ...note, where });
  };
  const check = (value: unknown, place: Place, skip?: (path: readonly string[]) => boolean) => eachString(value, (text) => {
    if (isStorePath(text)) add(place.where, linkNote(text, place, manifest.id));
    add(place.where, merchantFieldNote(text, manifest.id));
    add(place.where, identityNote(text, manifest.name));
  }, skip);

  const storefront = manifest.storefront;
  const sectionId = (section: unknown, index: number) => (isRecord(section) && typeof section.id === "string" ? section.id : String(index));

  for (const template of storefront.templates) {
    const theme = isRecord(template.theme) ? template.theme : {};
    const where = `template ${template.id}`;
    if (Array.isArray(theme.sections)) {
      theme.sections.forEach((section, index) => check(section, { where: `${where}, section ${sectionId(section, index)}`, section: true, header: false, default: false }));
    }
    const apps = isRecord(theme.apps) ? theme.apps : {};
    const skins = isRecord(apps.skins) ? apps.skins : {};
    for (const [unit, skin] of Object.entries(skins)) {
      check(skin, { where: `${where}, ${unit} skin`, section: false, header: unit === "header", default: false });
    }
    for (const [key, part] of Object.entries(theme)) {
      if (key === "sections" || key === "apps") continue;
      // Card fields are checked by storefrontTemplateCardFieldNotes.
      check(part, { where: `${where}, ${key}`, section: false, header: false, default: false }, (path) => key === "blocks" && path[0] === "card" && path[1] === "fields");
    }
    check({ ...apps, skins: undefined }, { where: `${where}, apps`, section: false, header: false, default: false });
  }
  for (const preset of storefront.pagePresets) {
    const sections = Array.isArray(preset.sections) ? preset.sections : [];
    sections.forEach((section, index) => check(section, { where: `page preset ${preset.id}, section ${sectionId(section, index)}`, section: true, header: false, default: false }));
  }
  const defaults = (kind: string, id: string, settings: ReadonlyArray<{ key: string; default?: unknown }>, header: boolean) => {
    for (const setting of settings) {
      if (setting.default === undefined) continue;
      check(setting.default, { where: `${kind} ${id} setting ${setting.key}`, section: false, header, default: true });
    }
  };
  for (const section of storefront.sections) defaults("section", section.type, section.settings, false);
  for (const component of storefront.components) defaults("component", component.type, component.settings, false);
  for (const skin of storefront.skins) defaults("skin", skin.id, skin.settings, skin.target === "header");

  for (const file of options.publicFiles ?? []) {
    if (!IMAGE_FILE.test(file.path)) continue;
    const where = `public/${file.path}`;
    if (file.bytes > STOREFRONT_ARTWORK_WARN_BYTES) {
      add(where, {
        level: "warn",
        rule: "artwork_size",
        message: `is ${Math.round(file.bytes / 1024)} KiB, and every store that shows it downloads it. Compress it under ${STOREFRONT_ARTWORK_WARN_BYTES / 1024} KiB (WebP or AVIF, at most 1600px wide), or give the section an image setting so merchants use their own photos.`,
      });
    }
    const mark = thirdPartyMark(file.path);
    if (mark) {
      add(where, {
        level: "warn",
        rule: "artwork_mark",
        message: `is named after "${mark}", which looks like a third-party mark. Ship only artwork you made or hold a licence to give every store that installs your app: game covers, console, publisher and brand logos are not yours to bundle. Ship neutral placeholders and let merchants pick their own images.`,
      });
    }
  }
  return notes;
}

/** The third-party mark a file name suggests, or null. */
export function thirdPartyMark(path: string): string | null {
  const stem = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").toLowerCase();
  const tokens = stem.split(/[^a-z0-9]+/).filter(Boolean);
  for (const { mark, tokens: wanted } of MARK_TOKENS) {
    for (let start = 0; start + wanted.length <= tokens.length; start += 1) {
      if (wanted.every((token, offset) => tokens[start + offset] === token)) return mark;
    }
  }
  return null;
}

/**
 * `custom.<key>` string literals in a compiled storefront module: a card or
 * section that reads a merchant field no other store has. Reads the text
 * only; nothing runs.
 */
export function storefrontModuleFieldNotes(moduleText: string, appId: string): StorefrontPortabilityNote[] {
  const keys = new Set<string>();
  for (const match of moduleText.matchAll(/["'`](?:resource\.cf\.)?custom\.([a-z][a-z0-9_]*)["'`]/g)) keys.add(match[1]!);
  return [...keys].sort().map((key) => ({
    level: "warn" as const,
    rule: "merchant_field" as const,
    where: "storefront module",
    message: `reads custom.${key}: custom.* is the merchant's own namespace, so no other store has it and your component draws nothing there. Declare the field in customFields, name it ${appId}.${key} and write its values with ctx.customFields, or read the card fields the merchant chose (product.fields) without naming one.`,
  }));
}
