// What a read does with a stored theme the current schema refuses for a
// reason a later build may have tightened: it repairs that one value and
// reads the rest, never failing the whole document (which would draw the
// default theme). Only a write refuses (save.ts, with the same reason).
//
// Two kinds of refusal are repaired, each the narrowest way that never draws
// an unchecked value:
//
// - A check with a save reason (`params.reason`): a link a stricter link
//   check refuses reads as no link (`invalid_link`: the slide or the
//   announcement is not a link); a bottom bar tab a stricter tab or
//   store-path check refuses is left out (`tab_*`), the bar the store's own
//   when too few remain; a slide's product past the page's bound reads as no
//   product; an arrangement nested past the bound is left out (that page
//   draws the store's own arrangement); a label a save refuses
//   (`label_variant`, `label_too_long`) reads as the store's own words.
// - A member of a closed list this build does not know
//   (`STOREFRONT_READ_UNKNOWN_MEMBER`): the store's default for it, or it is
//   left out (a section, a tab, a page's tokens or arrangement); and a key
//   this build does not know in any stored object (a later release's field):
//   left out. `strict()` holds only for a save.
//
// Anything else (a wrong type, a missing field, a bound the renderer relies
// on) is not repaired: the document does not read.

import { STOREFRONT_MOBILE_DEFAULT_TABS, STOREFRONT_MOBILE_TAB_LIMITS } from "./blocks";
import { PRIVATE_PAGE_KEYS } from "./private-keys";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { unionKeyIssues } from "../unknown-keys";

type Json = Record<string, unknown>;

/** A value a read repaired: where it was and why (its save reason, or `unknown_member`). */
export interface StorefrontThemeReadRepair {
  path: string;
  reason: string;
}

/**
 * The reason recorded for a member of a closed list this build does not know.
 * The theme document's closed lists (label keys and variants, icon keys, the
 * controls' places, layout kinds and part names, token values such as fonts,
 * block variants and their choices, section types, tab destinations and
 * icons, the template id, the homepage's kind) only grow: a member is never
 * removed or renamed once released. This repair is how a build reads a
 * member a later release added (a storefront a release behind its API, or
 * rolled back alone), and the guard against a removal by mistake, never a
 * licence for one.
 */
export const STOREFRONT_READ_UNKNOWN_MEMBER = "unknown_member";

/** The structural issue fields a repair reads (a Zod issue). */
export interface StorefrontThemeReadIssue {
  code: string;
  path: readonly PropertyKey[];
  params?: Record<string, unknown> | undefined;
  keys?: readonly string[] | undefined;
}

/** The save reason of a schema refusal of a label: words over a bound, else a value the key does not take. */
export function storefrontLabelRefusalReason(code: string): "label_too_long" | "label_variant" {
  return code === "too_big" ? "label_too_long" : "label_variant";
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isRecord(value) && !Array.isArray(value)) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

/** The index right after `name` in a path, with the path to the list (`[..., "tabs", 2, ...]` → the tabs and 2). */
function listEntry(path: readonly PropertyKey[], name: string): { list: readonly PropertyKey[]; index: number } | null {
  const at_ = path.indexOf(name);
  const index = path[at_ + 1];
  return at_ >= 0 && typeof index === "number" ? { list: path.slice(0, at_ + 1), index } : null;
}

/** A section list's entry: the homepage, a landing page's or a page template's. */
function sectionEntry(path: readonly PropertyKey[]): { list: readonly PropertyKey[]; index: number } | null {
  if (path[0] !== "pages") return null;
  const list = path[1] === "home" ? path.slice(0, 2) : (path[1] === "landing" || path[1] === "templates") && path[3] === "sections" ? path.slice(0, 4) : null;
  if (!list) return null;
  const index = path[list.length];
  return typeof index === "number" ? { list, index } : null;
}

const SAVE_REASON_TAB = /^tab_/;

/**
 * The document with every refused value repaired, and what was repaired; null
 * when an issue is not one a read repairs. Pure: the document is not changed.
 */
export function repairStoredStorefrontTheme(
  document: Json,
  issues: readonly StorefrontThemeReadIssue[],
  /** What earlier rounds repaired: a link nulled where null is not allowed is repaired one level up. */
  earlier: readonly StorefrontThemeReadRepair[] = [],
): { document: Json; repairs: StorefrontThemeReadRepair[] } | null {
  const nulledLinks = new Set(earlier.filter((repair) => repair.reason === "invalid_link").map((repair) => repair.path));
  const next = structuredClone(document);
  const repairs: StorefrontThemeReadRepair[] = [];
  const set = (path: readonly PropertyKey[], value: unknown) => {
    const parent = at(next, path.slice(0, -1));
    if (!isRecord(parent) && !Array.isArray(parent)) return false;
    (parent as Record<PropertyKey, unknown>)[path.at(-1)!] = value;
    return true;
  };
  const remove = (path: readonly PropertyKey[]) => {
    const parent = at(next, path.slice(0, -1));
    if (!isRecord(parent)) return false;
    delete parent[path.at(-1) as string];
    return true;
  };
  // Entries left out of a list, applied from the last so earlier indexes stay right.
  const drops = new Map<string, { list: readonly PropertyKey[]; indexes: Set<number> }>();
  const defaultAt = (path: readonly PropertyKey[]) => at(DEFAULT_STOREFRONT_THEME, path);
  const drop = (entry: { list: readonly PropertyKey[]; index: number }) => {
    const key = JSON.stringify(entry.list);
    const known = drops.get(key) ?? { list: entry.list, indexes: new Set<number>() };
    known.indexes.add(entry.index);
    drops.set(key, known);
    return true;
  };

  for (const issue of unionKeyIssues(issues)) {
    const path = issue.path;
    const reason = typeof issue.params?.reason === "string" ? issue.params.reason : null;
    const record = (why: string) => repairs.push({ path: path.map(String).join("."), reason: why });
    let done = false;
    let unknown = false;
    const tab = path[0] === "blocks" && path[1] === "mobileNav" ? listEntry(path, "tabs") : null;
    if (reason === "invalid_link" || reason === "slide_products_over_limit") {
      done = set(path, null);
    } else if (issue.code === "invalid_type" && nulledLinks.has(path.map(String).join("."))) {
      // A link refused where the field takes no null (a card's, a call to action's): one level up, the card is
      // left out of its list, or the call to action reads as none; never a working link.
      const index = path.length - 2;
      const card = typeof path[index] === "number" ? { list: path.slice(0, index), index: path[index] as number } : null;
      done = card ? drop(card) : set(path.slice(0, -1), null);
      if (done) {
        repairs.push({ path: (card ? path.slice(0, index + 1) : path.slice(0, -1)).map(String).join("."), reason: "invalid_link" });
        continue;
      }
    } else if (reason && SAVE_REASON_TAB.test(reason) && tab) {
      done = drop(tab);
    } else if (reason === "too_deep" && path[0] === "privatePages" && path[1] === "pages" && path.length === 3) {
      done = remove(path);
    } else if (!reason && path[0] === "privatePages" && path[1] === "labels" && path.length >= 3) {
      // A label a save refuses (`label_variant`, `label_too_long`): the store's own words there.
      done = remove(path.slice(0, 3));
    } else if (issue.code === "unrecognized_keys") {
      // A key this build does not know, in any stored object (a field a later release added, a label or icon key,
      // a key of the compile): left out, so a build never fails a row a newer build wrote. Only a save is strict.
      unknown = true;
      done = (issue.keys ?? []).every((key) => remove([...path, key]));
    } else if (path[0] === "privatePages" && path[1] === "icons" && path.length >= 3) {
      unknown = true;
      done = remove(path.slice(0, 3));
    } else if (path.length === 2 && path[0] === "privatePages" && path[1] === "controls") {
      // A place for the controls this build does not know: the store's header.
      unknown = true;
      done = remove(path);
    } else if (path.length === 2 && path[0] === "privatePages" && path[1] === "tokens") {
      // Tokens for a page this build does not know: left out.
      unknown = true;
      const tokens = at(next, path);
      done = isRecord(tokens) && Object.keys(tokens).every((page) => (PRIVATE_PAGE_KEYS as readonly string[]).includes(page) || remove([...path, page]));
    } else if (path[0] === "privatePages" && path[1] === "pages" && typeof path[2] === "string" && path.length > 3) {
      // An arrangement naming a layout or a node this build does not know: that page draws the store's own.
      unknown = true;
      done = remove(path.slice(0, 3));
    } else if (issue.code === "invalid_value" && path.length === 2 && path[0] === "tokens" && typeof at(next, path) === "string" && defaultAt(path) !== undefined) {
      // A token value (a font, a density) this build does not know: the default theme's.
      unknown = true;
      done = set(path, structuredClone(defaultAt(path)));
    } else if (tab && (issue.code === "invalid_union" || issue.code === "invalid_value")) {
      // A destination this build does not know: the tab is left out; a store icon it does not know: the link icon.
      unknown = true;
      done = path.at(-1) === "name" && path.at(-2) === "icon" ? set(path, "link") : drop(tab);
    } else if ((issue.code === "invalid_union" || issue.code === "invalid_value") && (path[0] === "template" || (path[0] === "pages" && path[1] === "homeMode"))) {
      // A template id or a homepage kind this build does not know: the default theme's.
      unknown = true;
      const place = path[0] === "template" ? path.slice(0, 1) : path.slice(0, 2);
      done = set(place, structuredClone(defaultAt(place)));
    } else if ((issue.code === "invalid_union" || issue.code === "invalid_value") && path[0] === "blocks" && typeof path[1] === "string" && defaultAt(path.slice(0, 2)) !== undefined) {
      // A block variant (or one of its choices) this build does not know: the default theme's block there.
      unknown = true;
      done = set(path.slice(0, 2), structuredClone(defaultAt(path.slice(0, 2))));
    } else if ((issue.code === "invalid_union" || issue.code === "invalid_value") && sectionEntry(path) !== null) {
      // A section type, or a choice of its settings, this build does not know: the section is left out.
      unknown = true;
      done = drop(sectionEntry(path)!);
    }
    if (!done) return null;
    record(reason ?? (unknown ? STOREFRONT_READ_UNKNOWN_MEMBER : storefrontLabelRefusalReason(issue.code)));
  }

  for (const { list, indexes } of drops.values()) {
    const entries = at(next, list);
    if (!Array.isArray(entries)) return null;
    const kept = entries.filter((_, index) => !indexes.has(index));
    if (list.at(-1) === "tabs") {
      set(list, kept.length >= STOREFRONT_MOBILE_TAB_LIMITS.min ? kept : STOREFRONT_MOBILE_DEFAULT_TABS.map((each) => ({ ...each })));
      continue;
    }
    set(list, kept);
    // A page template's fixed part keeps its place among the sections that stay.
    const template = list[1] === "templates" ? at(next, list.slice(0, -1)) : null;
    if (isRecord(template) && typeof template.main === "number") {
      template.main -= [...indexes].filter((index) => index < (template.main as number)).length;
    }
  }
  return { document: next, repairs };
}
