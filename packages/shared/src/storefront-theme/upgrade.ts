// The upgrade chain (../storefront-theme.md, "Compatibility"): a stored theme
// document of an older version is upgraded when it is read, one version at a
// time, and then parsed strictly as the current version. The next save
// stores the current version; nothing is written on read.
//
// A step is pure JSON in, JSON out (no I/O, no clock) and changes only the
// parts it finds: app templates and page presets carry parts of a document
// (their tokens, blocks, skins and sections) and run through the same steps.
// Section types keep their own chains in the registry (`upgrades` beside
// `version`, sections.ts), run on every section list after the document steps.

import { STOREFRONT_THEME_DOCUMENT_VERSION, storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { STOREFRONT_SECTION_REGISTRY, type StorefrontSectionSettingsUpgrade } from "./sections";

/**
 * The oldest stored version that still reads. Migration 0155 reset every
 * stored theme to version 10, so the chain starts there.
 */
export const STOREFRONT_THEME_OLDEST_READABLE_VERSION = 10 as const;

type Json = Record<string, unknown>;

/** One document step: a document (or a part of one) at version `n` in, at `n + 1` out. */
export type StorefrontThemeDocumentUpgrade = (document: Json) => Json;

/** `<plugin id>/<name>` as version 10 named an app surface: the name kebab-case. */
const V10_APP_KEY = /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)\/([a-z][a-z0-9-]{0,47})$/;

/** Every `app` and `template` value that names an app surface, with its name's hyphens as underscores. */
function snakeAppKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeAppKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if ((key === "app" || key === "template") && typeof entry === "string") {
      const match = V10_APP_KEY.exec(entry);
      return [key, match ? `${match[1]}/${match[2]!.replaceAll("-", "_")}` : entry];
    }
    return [key, snakeAppKeys(entry)];
  }));
}

/**
 * The document steps by the version they upgrade from: entry `n` turns a
 * version `n` document into version `n + 1`. compat.test.ts requires one for
 * every version from the oldest readable one to the one before the current.
 *
 * - 10 → 11: an app's section, block, skin and template names are snake_case
 *   (the manifest's identifier rule, plugins/manifest-patterns.ts), so every
 *   `<plugin id>/<name>` the document names (an app section's `app`, a skin's
 *   or product block's `app`, `apps.template`) reads with the name's hyphens
 *   as underscores: the name its app now declares.
 */
export const STOREFRONT_THEME_DOCUMENT_UPGRADES: Readonly<Record<number, StorefrontThemeDocumentUpgrade>> = {
  10: (document) => snakeAppKeys(document) as Json,
};

/** A chain: the versions it reads, its document steps and each section type's own. */
export interface StorefrontThemeUpgradeChain {
  oldest: number;
  current: number;
  documents: Readonly<Record<number, StorefrontThemeDocumentUpgrade>>;
  /** A core section type's version and steps; null for an app section or an unknown type. */
  section(type: string): { version: number; upgrades: Readonly<Record<number, StorefrontSectionSettingsUpgrade>> } | null;
}

/** The chain of this build: the document steps above and the section registry's. */
export const STOREFRONT_THEME_UPGRADE_CHAIN: StorefrontThemeUpgradeChain = {
  oldest: STOREFRONT_THEME_OLDEST_READABLE_VERSION,
  current: STOREFRONT_THEME_DOCUMENT_VERSION,
  documents: STOREFRONT_THEME_DOCUMENT_UPGRADES,
  section: (type) => Object.hasOwn(STOREFRONT_SECTION_REGISTRY, type)
    ? STOREFRONT_SECTION_REGISTRY[type as keyof typeof STOREFRONT_SECTION_REGISTRY]
    : null,
};

/** Why a stored document did not upgrade. */
export class StorefrontThemeUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorefrontThemeUpgradeError";
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: unknown, what: string): StorefrontThemeUpgradeError {
  return error instanceof StorefrontThemeUpgradeError
    ? error
    : new StorefrontThemeUpgradeError(`${what} failed (${error instanceof Error ? error.name : "error"}).`);
}

/**
 * One section at its type's current version: the type's own steps applied to
 * its settings. App sections and unknown types are returned as they are (the
 * schema decides); a version above the current one stays, and fails the schema.
 */
export function upgradeStorefrontSection(section: unknown, chain: StorefrontThemeUpgradeChain = STOREFRONT_THEME_UPGRADE_CHAIN): unknown {
  if (!isRecord(section) || typeof section.type !== "string") return section;
  const entry = chain.section(section.type);
  const from = section.version;
  if (!entry || typeof from !== "number" || !Number.isInteger(from) || from >= entry.version) return section;
  let settings: unknown = section.settings;
  for (let version = from; version < entry.version; version += 1) {
    const step = entry.upgrades[version];
    if (!step) throw new StorefrontThemeUpgradeError(`No upgrade for ${section.type} sections from version ${version}.`);
    try {
      settings = step(settings);
    } catch (error) {
      throw failure(error, `The ${section.type} section upgrade from version ${version}`);
    }
  }
  return { ...section, version: entry.version, settings };
}

/** A section list with every section upgraded; anything that is not a list is returned as it is. */
export function upgradeStorefrontSectionList(list: unknown, chain: StorefrontThemeUpgradeChain = STOREFRONT_THEME_UPGRADE_CHAIN): unknown {
  return Array.isArray(list) ? list.map((section) => upgradeStorefrontSection(section, chain)) : list;
}

/** The section lists of a (partial) current document upgraded: the homepage, each landing page, each page template. */
function upgradeSectionLists(document: Json, chain: StorefrontThemeUpgradeChain): Json {
  const pages = document.pages;
  if (!isRecord(pages)) return document;
  const each = (record: unknown) => isRecord(record)
    ? Object.fromEntries(Object.entries(record).map(([key, page]) => [key, isRecord(page) && "sections" in page
      ? { ...page, sections: upgradeStorefrontSectionList(page.sections, chain) }
      : page]))
    : record;
  const next: Json = { ...pages };
  if ("home" in pages) next.home = upgradeStorefrontSectionList(pages.home, chain);
  if ("landing" in pages) next.landing = each(pages.landing);
  if ("templates" in pages) next.templates = each(pages.templates);
  return { ...document, pages: next };
}

/**
 * A document (or part of one) of any readable version at the current version:
 * the document steps from its `version`, then every section's own steps. The
 * result is not validated (callers parse it strictly). Throws a
 * `StorefrontThemeUpgradeError` for a version that does not read or a step
 * that fails.
 */
export function upgradeStorefrontThemeDocument(value: unknown, chain: StorefrontThemeUpgradeChain = STOREFRONT_THEME_UPGRADE_CHAIN): Json {
  if (!isRecord(value)) throw new StorefrontThemeUpgradeError("A theme document is an object.");
  const from = value.version;
  if (typeof from !== "number" || !Number.isInteger(from)) throw new StorefrontThemeUpgradeError("A theme document states its version.");
  if (from < chain.oldest) throw new StorefrontThemeUpgradeError(`Version ${from} is older than the oldest readable version (${chain.oldest}).`);
  if (from > chain.current) throw new StorefrontThemeUpgradeError(`Version ${from} is newer than this store reads (${chain.current}).`);
  let document: Json = value;
  for (let version = from; version < chain.current; version += 1) {
    const step = chain.documents[version];
    if (!step) throw new StorefrontThemeUpgradeError(`No upgrade from version ${version}.`);
    try {
      document = { ...step(document), version: version + 1 };
    } catch (error) {
      throw failure(error, `The upgrade from version ${version}`);
    }
  }
  return upgradeSectionLists(document, chain);
}

/** A stored document read through the chain: the current document and the version it was stored at. */
export type StoredStorefrontThemeRead =
  | { ok: true; document: StorefrontThemeDocument; storedVersion: number }
  | { ok: false; reason: string };

/** Reads a stored document (JSON text or a parsed value): upgraded, then strictly parsed. */
export function readStoredStorefrontThemeDocument(value: unknown): StoredStorefrontThemeRead {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, reason: "The stored theme is not JSON." };
    }
  }
  let upgraded: Json;
  try {
    upgraded = upgradeStorefrontThemeDocument(parsed);
  } catch (error) {
    return { ok: false, reason: error instanceof StorefrontThemeUpgradeError ? error.message : "The stored theme did not upgrade." };
  }
  const result = storefrontThemeDocumentSchema.safeParse(upgraded);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, reason: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, document: result.data, storedVersion: (parsed as Json).version as number };
}

/**
 * Parses a stored document: upgraded from any readable version, then strictly
 * parsed as the current one. Null for an unreadable document; callers decide
 * what that means (the dashboard fails closed, the storefront renders the
 * default theme).
 */
export function parseStoredStorefrontThemeDocument(value: string | null | undefined): StorefrontThemeDocument | null {
  if (!value) return null;
  const read = readStoredStorefrontThemeDocument(value);
  return read.ok ? read.document : null;
}
