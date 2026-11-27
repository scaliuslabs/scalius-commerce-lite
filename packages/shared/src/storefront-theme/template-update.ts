// Shipping a template update to stores already on it: a three-way merge of
// the store's document (MINE) with the template it was applied from (BASE,
// as that release shipped it) and the same template in the new release
// (THEIRS), at the granularity the document already has. Contract:
// ../storefront-theme.md, "Template updates".
//
// - A leaf the author changed (BASE ≠ THEIRS) that the merchant never touched
//   (MINE = BASE) is an improvement: taking it sets THEIRS.
// - One the merchant changed too is a conflict: MINE stays unless the
//   merchant takes THEIRS for that item.
// - Without a BASE (`base: null`, a store applied before bases were kept and
//   compared on request) every difference from THEIRS is a conflict, so
//   nothing changes unless the merchant takes it.
//
// Only what the template owns is compared: its tokens (the colour scheme,
// dark colours and switch only while it shows dark colours: otherwise they
// stay the merchant's, as an apply keeps them), each block it names, its unit
// skins, its private pages and its homepage sections. A part THEIRS no
// longer names (a block, the tokens, the private pages) is left as the store
// has it, as applying THEIRS would leave it.
//
// Identity. Homepage sections by id (a list the merchant reordered keeps the
// merchant's order); a unit skin by unit; a block by slot; a private page's
// arrangement, a label and an icon whole (an arrangement is a layout: two
// edits of one tree merged node by node make a layout no one designed); a
// private token by page, part and token. Any other list (tabs, a product
// page's modules, a receipt's cards) is one value. An object whose
// discriminator (`variant`, `type`, `kind`, `app`, `layout`, `style`) differs
// between the three is one value too: its fields belong to that choice.
//
// Pure: the store's caller reads BASE and THEIRS through the template read
// (handles resolved against the store, card fields it lacks left out) and runs
// the save check on the merged document like any save.

import type { StorefrontAppTemplateTheme } from "./app-templates";
import type { StorefrontThemeDocument } from "./document";
import { storefrontCanonicalJson, storefrontFingerprint } from "./fingerprint";
import type { StorefrontSection } from "./sections";
import { storefrontDarkColorsAreMade, storefrontDarkPalette, storefrontThemeShowsDarkColors } from "./tokens";

/** Where an item sits: the template part it belongs to. */
export type StorefrontTemplateUpdateArea = "tokens" | "blocks" | "skins" | "privatePages" | "home";

/** One change the update brings. */
export interface StorefrontTemplateUpdateItem {
  /** Stable within one proposal: its path, `/`-joined. */
  id: string;
  /** `improvement`: the merchant never changed it since the template was applied; `conflict`: they did (or the store keeps no base). */
  kind: "improvement" | "conflict";
  area: StorefrontTemplateUpdateArea;
  /** What taking it does: set a value, add or remove a homepage section, or order the template's sections as the update does. */
  change: "set" | "add" | "remove" | "order";
  /** Where in the update's view of the document: `["tokens", "colors", "primary"]`, `["home", "<section id>", "settings", "title"]`, `["skins", "header"]`. */
  path: string[];
  /** The store's value now (absent: none); for `order`, the template sections' ids in the store's order. */
  mine?: unknown;
  /** The update's value (absent: it removes it); for `order`, the same ids in the update's order. */
  theirs?: unknown;
  /** An added section that takes the place of one the update removes (a renamed id): the id it replaces. */
  replaces?: string;
}

/** What a template update is computed from. */
export interface StorefrontTemplateUpdateInput {
  /** The store's document (the draft). */
  mine: StorefrontThemeDocument;
  /** The template the document is on (`<app id>/<template id>`). */
  key: string;
  /** The template as the release the store applied (or last reviewed) shipped it, read against this store; null: not known. */
  base: StorefrontAppTemplateTheme | null;
  /** The template in the installed release, read against this store. */
  theirs: StorefrontAppTemplateTheme;
  /** Ids of THEIRS's sections left out for a handle this store lacks: never read as removed. */
  unresolved?: readonly string[];
}

type Json = Record<string, unknown>;
const UNKNOWN = Symbol("unknown base");
type Base = unknown | typeof UNKNOWN;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown) => storefrontCanonicalJson(left ?? null) === storefrontCanonicalJson(right ?? null) && (left === undefined) === (right === undefined);

/** The keys whose value decides what an object's other fields mean. */
const DISCRIMINATORS = ["variant", "type", "kind", "app", "layout", "style"] as const;
/** The colour scheme's tokens: the template's only while it shows dark colours. */
const SCHEME_TOKENS = ["colorScheme", "darkColors", "colorSchemeToggle"] as const;
/** The private pages' parts a template sets (`compiled` is the store's). */
const PRIVATE_PARTS = ["controls", "pages", "tokens", "labels", "icons"] as const;

/** A path compared whole: a private page's arrangement, a label, an icon, one private token, the page paint. */
function wholeAt(path: readonly string[]): boolean {
  const [area, part] = path;
  if (area === "tokens") return part === "pagePaint" && path.length === 2;
  if (area === "privatePages") {
    if (part === "pages" || part === "labels" || part === "icons") return path.length === 3;
    if (part === "tokens") return path.length === 5;
  }
  return false;
}

/** The three differ on what the object is: its fields belong to that choice. */
function discriminated(values: readonly unknown[]): boolean {
  const objects = values.filter(isObject);
  return DISCRIMINATORS.some((key) => objects.some((each) => key in each) && new Set(objects.map((each) => storefrontCanonicalJson(each[key] ?? null))).size > 1);
}

function itemId(path: readonly string[]): string {
  return path.map((segment) => encodeURIComponent(segment)).join("/");
}

function areaOf(path: readonly string[]): StorefrontTemplateUpdateArea {
  return path[0] as StorefrontTemplateUpdateArea;
}

/** Leaf by leaf: what the author changed, set against what the merchant did. */
function walk(path: string[], base: Base, theirs: unknown, mine: unknown, items: StorefrontTemplateUpdateItem[]): void {
  const known = base !== UNKNOWN;
  if (known && same(base, theirs)) return;
  if (same(mine, theirs)) return;
  const descend = !wholeAt(path) && isObject(theirs) && (known ? (isObject(base) || isObject(mine)) && (base === undefined || isObject(base)) : isObject(mine))
    && (mine === undefined || isObject(mine)) && !discriminated(known ? [base, theirs, mine] : [theirs, mine]);
  if (descend) {
    const keys = new Set([...(known && isObject(base) ? Object.keys(base) : []), ...Object.keys(theirs)]);
    for (const key of [...keys].sort()) {
      walk([...path, key], known ? (base as Json | undefined)?.[key] : UNKNOWN, theirs[key], (mine as Json | undefined)?.[key], items);
    }
    return;
  }
  if (!known && theirs === undefined) return;
  items.push({
    id: itemId(path),
    kind: known && same(mine, base) ? "improvement" : "conflict",
    area: areaOf(path),
    change: "set",
    path,
    ...(mine === undefined ? {} : { mine }),
    ...(theirs === undefined ? {} : { theirs }),
  });
}

function pick(value: Json | undefined, keys: readonly string[]): Json {
  if (!value) return {};
  return Object.fromEntries(keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])));
}

function omit(value: Json, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** The tokens a template owns: all of them while it shows dark colours, else all but the colour scheme's. */
function ownedTokens(tokens: Json | undefined, showsDark: boolean): Json | undefined {
  if (!tokens) return undefined;
  return showsDark ? tokens : omit(tokens, SCHEME_TOKENS);
}

/** The look's parts (tokens, blocks, skins, private pages), BASE and THEIRS against MINE, leaf by leaf. */
function planLook(input: StorefrontTemplateUpdateInput, items: StorefrontTemplateUpdateItem[]): void {
  const { mine, theirs } = input;
  const base: StorefrontAppTemplateTheme | typeof UNKNOWN = input.base ?? UNKNOWN;
  const known = base !== UNKNOWN;
  // The tokens, when THEIRS sets them; the colour scheme's only while it shows dark colours.
  if (theirs.tokens) {
    const showsDark = storefrontThemeShowsDarkColors(theirs.tokens);
    const baseTokens = known ? ownedTokens(base.tokens as Json | undefined, base.tokens ? storefrontThemeShowsDarkColors(base.tokens) && showsDark : false) : UNKNOWN;
    const mineTokens = showsDark ? mine.tokens : omit(mine.tokens as unknown as Json, SCHEME_TOKENS);
    walk(["tokens"], baseTokens, ownedTokens(theirs.tokens as unknown as Json, showsDark), mineTokens, items);
  }
  // Each block THEIRS names, by slot: a block it no longer names stays as the store has it.
  for (const [slot, block] of Object.entries(theirs.blocks ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (block === undefined) continue;
    walk(["blocks", slot], known ? (base.blocks as Json | undefined)?.[slot] : UNKNOWN, block, (mine.blocks as unknown as Json)[slot], items);
  }
  // Unit skins by unit: one the update drops goes (it was the template's).
  const baseSkins = known ? (base.apps?.skins ?? {}) as Json : {};
  const theirSkins = (theirs.apps?.skins ?? {}) as Json;
  const mineSkins = (mine.apps?.skins ?? {}) as Json;
  for (const unit of [...new Set([...Object.keys(baseSkins), ...Object.keys(theirSkins)])].sort()) {
    walk(["skins", unit], known ? baseSkins[unit] : UNKNOWN, theirSkins[unit], mineSkins[unit], items);
  }
  // The private pages, when THEIRS sets them (an apply replaces the store's whole object with them).
  if (theirs.privatePages) {
    walk(
      ["privatePages"],
      known ? pick(base.privatePages as Json | undefined, PRIVATE_PARTS) : UNKNOWN,
      pick(theirs.privatePages as Json, PRIVATE_PARTS),
      pick(mine.privatePages as unknown as Json, PRIVATE_PARTS),
      items,
    );
  }
}

/** The relative order of `ids` in `list`. */
function orderOf(list: readonly StorefrontSection[], ids: ReadonlySet<string>): string[] {
  return list.map((section) => section.id).filter((id) => ids.has(id));
}

/** The homepage sections, by id; and their order. */
function planHome(input: StorefrontTemplateUpdateInput, items: StorefrontTemplateUpdateItem[]): void {
  const theirs = input.theirs.sections;
  if (!theirs) return;
  const known = input.base !== null;
  const base = known ? input.base!.sections ?? [] : [];
  const mine = input.mine.pages.home;
  const unresolved = new Set(input.unresolved ?? []);
  const byId = (list: readonly StorefrontSection[]) => new Map(list.map((section) => [section.id, section]));
  const [baseById, theirsById, mineById] = [byId(base), byId(theirs), byId(mine)];
  const ids = [...new Set([...base.map((section) => section.id), ...theirs.map((section) => section.id)])];
  for (const id of ids) {
    if (unresolved.has(id)) continue;
    const [b, t, m] = [baseById.get(id), theirsById.get(id), mineById.get(id)];
    const path = ["home", id];
    if (!known) {
      // No base: what THEIRS has and the store does not, or has otherwise, is the merchant's to take.
      if (!t) continue;
      if (!m) items.push({ id: itemId(path), kind: "conflict", area: "home", change: "add", path, theirs: t });
      else walk(path, UNKNOWN, t, m, items);
      continue;
    }
    if (same(b, t)) continue;
    if (b && t && m) walk(path, b, t, m, items);
    // The merchant removed it and the update changed it: theirs to bring back.
    else if (b && t && !m) items.push({ id: itemId(path), kind: "conflict", area: "home", change: "add", path, theirs: t });
    // New in the update.
    else if (!b && t && !m) items.push({ id: itemId(path), kind: "improvement", area: "home", change: "add", path, theirs: t });
    // A section of the store's own under the same id.
    else if (!b && t && m) {
      if (!same(m, t)) items.push({ id: itemId(path), kind: "conflict", area: "home", change: "set", path, mine: m, theirs: t });
    }
    // The update removes it: gone when the merchant never changed it.
    else if (b && !t && m) items.push({ id: itemId(path), kind: same(m, b) ? "improvement" : "conflict", area: "home", change: "remove", path, mine: m });
  }
  if (!known) return;
  // A renamed id: the update removes a section and adds one of the same type. While the merchant keeps the
  // old one (a changed section is theirs), the new one is a choice too, never a second hero by default.
  for (const removed of items.filter((item) => item.area === "home" && item.change === "remove" && item.kind === "conflict")) {
    const type = (baseById.get(removed.path[1]!) as { type?: string } | undefined)?.type;
    const added = items.find((item) => item.area === "home" && item.change === "add" && item.replaces === undefined && (item.theirs as { type?: string }).type === type);
    if (added) Object.assign(added, { kind: "conflict", replaces: removed.path[1]! });
  }
  // Order: the template's sections the three share, as the update orders them, unless the merchant reordered them.
  const shared = new Set([...baseById.keys()].filter((id) => theirsById.has(id) && mineById.has(id)));
  const [baseOrder, theirOrder, mineOrder] = [orderOf(base, shared), orderOf(theirs, shared), orderOf(mine, shared)];
  if (same(baseOrder, theirOrder) || same(mineOrder, theirOrder)) return;
  items.push({ id: "home", kind: same(mineOrder, baseOrder) ? "improvement" : "conflict", area: "home", change: "order", path: ["home"], mine: mineOrder, theirs: theirOrder });
}

/**
 * What a template update brings to a store's document, item by item: the
 * improvements (the merchant never changed them since the template was
 * applied) and the conflicts (they did, or the store keeps no base). An
 * update that changes nothing the store has brings none.
 */
export function planStorefrontTemplateUpdate(input: StorefrontTemplateUpdateInput): StorefrontTemplateUpdateItem[] {
  const items: StorefrontTemplateUpdateItem[] = [];
  planLook(input, items);
  planHome(input, items);
  return items;
}

/** What a merchant who chooses nothing takes: every improvement, no conflict. */
export function storefrontTemplateUpdateDefaults(items: readonly StorefrontTemplateUpdateItem[]): Set<string> {
  return new Set(items.filter((item) => item.kind === "improvement").map((item) => item.id));
}

/** A proposal's fingerprint: what the merchant reviewed is what an apply takes. */
export function storefrontTemplateUpdateDigest(items: readonly StorefrontTemplateUpdateItem[]): string {
  return storefrontFingerprint(storefrontCanonicalJson(items));
}

function setAt(root: Json, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key] as Json;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete node[last];
  else node[last] = structuredClone(value);
}

/** Where a view path sits in the document: skins under `apps`, the rest at the same place. */
function documentPath(path: readonly string[]): string[] {
  return path[0] === "skins" ? ["apps", ...path] : [...path];
}

/**
 * The store's document with the chosen items taken (`take`: their ids; the
 * rest stay the merchant's). Recomputed from the input, so it applies exactly
 * the proposal `planStorefrontTemplateUpdate` gives for it. Dark colours the
 * store made from its colours (never edited) follow the colours taken; the
 * skins the template brought are recorded again (`apps.templateSkins`). The
 * caller saves it through the save check, which compiles the private pages.
 */
export function applyStorefrontTemplateUpdate(input: StorefrontTemplateUpdateInput, take: ReadonlySet<string>): StorefrontThemeDocument {
  const items = planStorefrontTemplateUpdate(input).filter((item) => take.has(item.id));
  const document = structuredClone(input.mine) as unknown as Json;
  let home = [...input.mine.pages.home];
  const adds: StorefrontTemplateUpdateItem[] = [];
  let order: string[] | null = null;
  for (const item of items) {
    if (item.area !== "home") {
      setAt(document, documentPath(item.path), item.theirs);
      continue;
    }
    if (item.change === "order") order = item.theirs as string[];
    else if (item.change === "add") adds.push(item);
    else if (item.change === "remove") home = home.filter((section) => section.id !== item.path[1]);
    else {
      const [, id, ...rest] = item.path;
      home = home.map((section) => {
        if (section.id !== id) return section;
        if (rest.length === 0) return structuredClone(item.theirs) as StorefrontSection;
        const next = structuredClone(section) as unknown as Json;
        setAt(next, rest, item.theirs);
        return next as unknown as StorefrontSection;
      });
    }
  }
  // A section the update adds sits after the one before it in the update, else before the one after it.
  const theirs = input.theirs.sections ?? [];
  const theirIds = theirs.map((section) => section.id);
  for (const item of [...adds].sort((a, b) => theirIds.indexOf(a.path[1]!) - theirIds.indexOf(b.path[1]!))) {
    const at = theirIds.indexOf(item.path[1]!);
    const before = theirIds.slice(0, at).reverse().find((id) => home.some((section) => section.id === id));
    const after = theirIds.slice(at + 1).find((id) => home.some((section) => section.id === id));
    const index = before !== undefined ? home.findIndex((section) => section.id === before) + 1
      : after !== undefined ? home.findIndex((section) => section.id === after)
        : home.length;
    home.splice(index, 0, structuredClone(item.theirs) as StorefrontSection);
  }
  // The template's sections take the update's order in the places they hold; the merchant's own stay where they are.
  if (order) {
    const rank = new Map(theirIds.map((id, index) => [id, index]));
    const slots = home.flatMap((section, index) => (rank.has(section.id) ? [index] : []));
    const placed = slots.map((index) => home[index]!).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    slots.forEach((index, at) => { home[index] = placed[at]!; });
  }
  (document.pages as Json).home = home;
  return finish(input, document as unknown as StorefrontThemeDocument, items);
}

/** Dark colours that follow the colours, and the record of the skins the template brought. */
function finish(input: StorefrontTemplateUpdateInput, document: StorefrontThemeDocument, taken: readonly StorefrontTemplateUpdateItem[]): StorefrontThemeDocument {
  const { mine, theirs } = input;
  const darkTaken = taken.some((item) => item.path[0] === "tokens" && item.path[1] === "darkColors");
  if (!darkTaken && mine.tokens.darkColors && storefrontDarkColorsAreMade(mine.tokens.colors, mine.tokens.darkColors) && !same(mine.tokens.colors, document.tokens.colors)) {
    document.tokens = { ...document.tokens, darkColors: storefrontDarkPalette(document.tokens.colors) };
  }
  const skins = document.apps?.skins ?? {};
  const brought = mine.apps?.templateSkins ?? {};
  const record = Object.fromEntries(Object.entries(skins).flatMap(([unit, skin]) => {
    const app = skin?.app;
    const theirApp = theirs.apps?.skins?.[unit as keyof typeof skins]?.app;
    return app && (app === theirApp || app === brought[unit as keyof typeof brought]) ? [[unit, app]] : [];
  }));
  const apps = { ...(document.apps ?? {}), template: input.key };
  if (Object.keys(skins).length === 0) delete (apps as Json).skins;
  if (Object.keys(record).length > 0) apps.templateSkins = record;
  else delete (apps as Json).templateSkins;
  return { ...document, apps };
}

/** The update's counts: improvements ready, and conflicts that need the merchant's choice. */
export function storefrontTemplateUpdateCounts(items: readonly StorefrontTemplateUpdateItem[]): { improvements: number; conflicts: number } {
  const improvements = items.filter((item) => item.kind === "improvement").length;
  return { improvements, conflicts: items.length - improvements };
}

/** An app's templates as one release's manifest declares them (`storefront.templates`). */
export interface StorefrontTemplateRelease {
  templates: ReadonlyArray<{ id: string; theme: unknown }>;
}

/** One finding of `storefrontTemplateReleaseNotes`: `warn` loses stores an update, `note` is a choice to be sure of. */
export interface StorefrontTemplateReleaseNote {
  level: "warn" | "note";
  message: string;
}

function declaredSections(theme: unknown): Array<{ id: string; type: string }> {
  const sections = isObject(theme) ? theme.sections : undefined;
  return Array.isArray(sections)
    ? sections.flatMap((section) => (isObject(section) && typeof section.id === "string" ? [{ id: section.id, type: String(section.type) }] : []))
    : [];
}

/**
 * What a release does to the stores on the previous one's templates, as
 * `scalius-plugin validate --previous` reports it. A template update merges
 * homepage sections by id: a section whose id changed is a new section to
 * a store that changed the old one (which keeps its copy), so a renamed id
 * warns; a template no longer shipped gets its stores no more updates.
 */
export function storefrontTemplateReleaseNotes(previous: StorefrontTemplateRelease, next: StorefrontTemplateRelease): StorefrontTemplateReleaseNote[] {
  const notes: StorefrontTemplateReleaseNote[] = [];
  for (const before of previous.templates) {
    const after = next.templates.find((template) => template.id === before.id);
    const at = `storefront.templates (${before.id})`;
    if (!after) {
      notes.push({ level: "warn", message: `${at} is no longer shipped: stores on it keep their theme and get no further updates from it.` });
      continue;
    }
    const [old, current] = [declaredSections(before.theme), declaredSections(after.theme)];
    const added = current.filter((section) => !old.some((each) => each.id === section.id));
    for (const section of old.filter((each) => !current.some((candidate) => candidate.id === each.id))) {
      const renamed = added.find((candidate) => candidate.type === section.type);
      notes.push(renamed
        ? { level: "warn", message: `${at}: section "${section.id}" is now "${renamed.id}". A store that changed "${section.id}" keeps its copy and gets "${renamed.id}" as a new section; keep the id to update it in place.` }
        : { level: "note", message: `${at}: section "${section.id}" is removed. Stores that never changed it lose it; stores that did are asked.` });
      if (renamed) added.splice(added.indexOf(renamed), 1);
    }
  }
  return notes;
}

/** A save check's issue, with the items it comes from (their place in the document is, or holds, the issue's). */
export interface StorefrontTemplateUpdateIssue {
  path: string;
  message: string;
  reason: string | null;
  itemIds: string[];
}

/**
 * The items each issue of the merged document's save check comes from: an
 * item whose place in the document holds the issue's place, or sits inside
 * it; for a contrast issue (`<text> on <surface> …`), the items of both
 * colours in that colour set too. Homepage items are placed by their
 * section's position in `merged`; skins sit under `apps`.
 */
export function storefrontTemplateUpdateIssueItems(
  items: readonly StorefrontTemplateUpdateItem[],
  merged: StorefrontThemeDocument,
  issues: ReadonlyArray<{ path: string; message: string; reason: string | null }>,
): StorefrontTemplateUpdateIssue[] {
  const places = items.map((item) => {
    if (item.area !== "home") return { id: item.id, place: documentPath(item.path).join(".") };
    if (item.change === "order") return { id: item.id, place: "pages.home" };
    const index = merged.pages.home.findIndex((section) => section.id === item.path[1]);
    return { id: item.id, place: index < 0 ? null : ["pages", "home", String(index), ...item.path.slice(2)].join(".") };
  });
  const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}.`);
  return issues.map((issue) => {
    const at = [issue.path];
    const contrast = issue.reason === "contrast" ? /^(\S+) on (?:the page paint \((?:dark colours, )?)?(\S+?)\)? has contrast/.exec(issue.message) : null;
    const set = issue.path.split(".")[1];
    if (contrast && issue.path.startsWith("tokens.")) at.push(`tokens.${set}.${contrast[1]}`, `tokens.${set}.${contrast[2]}`);
    const itemIds = places.filter(({ place }) => place !== null && at.some((path) => path !== "" && (within(place, path) || within(path, place)))).map(({ id }) => id);
    return { ...issue, itemIds };
  });
}
