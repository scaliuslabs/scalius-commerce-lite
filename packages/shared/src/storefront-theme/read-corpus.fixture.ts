// The documents a theme read is proved over, and the two ways a later release
// grows one without raising its version: a key added to an object, and a
// member added to a closed list. Shared by the stored read's proof
// (read-future-keys.test.ts) and the storefront's read of what the API sends
// (apps/storefront storefront-theme-read-corpus.test.ts).
import { STOREFRONT_TEMPLATE_IDS, storefrontThemeDocumentSchema } from "./document";
import { PRIVATE_PAGES } from "./private-anatomy";
import { PRIVATE_PAGE_KEYS } from "./private-keys";
import { checkStorefrontThemeSave } from "./save";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme } from "./templates";

type Json = Record<string, unknown>;
export type ThemePath = Array<string | number>;

/** The key a later release added, in every corpus. */
export const LATER_KEY = "zzAddedByALaterRelease";
/** The closed list member a later release added, in every corpus. */
export const LATER_MEMBER = "zz-added-by-a-later-release";

/** Every golden stored document (`compat/v*`) and the built-in templates, each with its name. */
export async function storedThemeDocuments(): Promise<Array<[string, unknown]>> {
  const [{ readFileSync, readdirSync }, { fileURLToPath }] = await Promise.all(["node:fs", "node:url"].map((specifier) => import(/* @vite-ignore */ specifier))) as [
    { readFileSync(path: string, encoding: "utf8"): string; readdirSync(path: string): string[] },
    { fileURLToPath(url: URL): string },
  ];
  const root = fileURLToPath(new URL("./compat/", import.meta.url));
  const goldens = readdirSync(root).filter((dir) => /^v\d+$/.test(dir)).flatMap((dir) => readdirSync(`${root}${dir}`).filter((file) => file.endsWith(".json")).flatMap((file) => {
    const value = JSON.parse(readFileSync(`${root}${dir}/${file}`, "utf8")) as unknown;
    return Array.isArray(value) ? value.map((document, index): [string, unknown] => [`${dir}/${file} #${index}`, document]) : [];
  }));
  return [
    ...goldens,
    ...STOREFRONT_TEMPLATE_IDS.map((id): [string, unknown] => [`template ${id}`, storefrontTemplateTheme(id)]),
    ["a private look on every page", privateLookDocument()],
  ];
}

/**
 * A saved theme with a compiled look on every private page that takes one
 * (the drawer takes the public pages' look), arrangements for the cart and
 * the drawer, words and the store's controls: so a read's repair of a
 * private page can be seen against its compiled look.
 */
export function privateLookDocument(): unknown {
  const doc = structuredClone(DEFAULT_STOREFRONT_THEME) as Json & { tokens: Json; privatePages: Json };
  doc.tokens = { ...doc.tokens, pagePaint: { kind: "color", color: "muted" } };
  const styled = PRIVATE_PAGE_KEYS.filter((page) => Object.keys(PRIVATE_PAGES[page].styles).length > 0);
  doc.privatePages = {
    ...doc.privatePages,
    controls: "header",
    tokens: Object.fromEntries(styled.map((page) => [page, { action: { radius: 0 } }])),
    pages: { cart: { layout: structuredClone(PRIVATE_PAGES.cart.layout) }, cartDrawer: { layout: structuredClone(PRIVATE_PAGES.cartDrawer.layout) } },
    labels: { "cart.heading": { en: "Your bag", bn: "আপনার ব্যাগ" }, "drawer.title": { en: "Bag" } },
  };
  const saved = checkStorefrontThemeSave(doc);
  if (!saved.ok) throw new Error(`The private look corpus document does not save: ${saved.refusal.message}`);
  if (Object.keys(saved.theme.privatePages.compiled.css).length !== styled.length) throw new Error("The private look corpus document compiled no look on some page.");
  return saved.theme;
}

/** The path of every object inside `value`. */
export function objectPaths(value: unknown, path: ThemePath = []): ThemePath[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  if (!value || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]))];
}

function stringPaths(value: unknown, path: ThemePath = []): ThemePath[] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringPaths(item, [...path, index]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => stringPaths(child, [...path, key]));
}

function copyAt(document: unknown, path: ThemePath, change: (parent: Record<string | number, unknown>, last: string | number | undefined) => void): unknown {
  const copy = structuredClone(document) as Json;
  let node: unknown = copy;
  for (const segment of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[segment];
  change(node as Record<string | number, unknown>, path.at(-1));
  return copy;
}

/** The document with `LATER_KEY` added to the object at `path`. */
export function withLaterKey(document: unknown, path: ThemePath): unknown {
  return copyAt(document, [...path, LATER_KEY], (parent) => { parent[LATER_KEY] = { from: "a later release" }; });
}

/**
 * The key a later release added beside the keys of the object at `path`, as
 * a member of the closed list those keys are (a label, an icon, a page's
 * tokens, a colour role): named like its first sibling (`cart.heading` →
 * `cart.zzlater`) and holding a copy of its value, so only the key is new.
 * Null for an object without keys.
 */
export function withLaterSibling(document: unknown, path: ThemePath): { document: unknown; key: string } | null {
  let node: unknown = document;
  for (const segment of path) node = (node as Record<string | number, unknown>)[segment];
  const first = node && typeof node === "object" && !Array.isArray(node) ? Object.keys(node)[0] : undefined;
  if (first === undefined) return null;
  const key = first.includes(".") ? `${first.slice(0, first.lastIndexOf("."))}.zzlater` : "zzlater";
  if (Object.hasOwn(node as Json, key)) return null;
  return { document: copyAt(document, [...path, key], (parent) => { parent[key] = structuredClone((parent as Json)[first]); }), key };
}

/** The document without the key at `path` (a field an older build did not write or send). */
export function withoutKey(document: unknown, path: ThemePath): unknown {
  return copyAt(document, path, (parent, last) => { delete parent[last!]; });
}

/**
 * The one part of a document a change at `path` belongs to: a section, a
 * landing page, a page template, a block, a token, a private page (with its
 * compiled look), a label or icon, an app surface. A read that repairs a
 * value there changes nothing outside it.
 */
export function ownerOf(path: ThemePath): ThemePath[] {
  const [head, second, third, fourth, fifth] = path;
  if (head === "pages" && second === "home" && typeof third === "number") return [path.slice(0, 3)];
  if (head === "pages" && (second === "landing" || second === "templates") && third !== undefined) {
    return fourth === "sections" && typeof fifth === "number" ? [path.slice(0, 5), [head, second, third, "main"]] : [path.slice(0, 3)];
  }
  if (head === "privatePages" && second === "pages" && third !== undefined) return [path.slice(0, 3), ["privatePages", "compiled", "css", third]];
  // One page's compiled look, or the compile as a whole (a compile missing a field reads as never compiled).
  if (head === "privatePages" && second === "compiled") return [third === "css" && fourth !== undefined ? path.slice(0, 4) : path.slice(0, 2)];
  if (head === "privatePages" && (second === "tokens" || second === "labels" || second === "icons") && third !== undefined) return [path.slice(0, 3)];
  if (head === "apps" && third !== undefined) return [path.slice(0, 3)];
  return [path.slice(0, Math.min(path.length, 2))];
}

/**
 * The paths where a read differs from what was sent outside the owner of the
 * change at `path` (`ownerOf`). A list entry the read left out (a section, a
 * tab) is compared as the list without it.
 */
export function changedOutside(sent: unknown, read: unknown, path: ThemePath): ThemePath[] {
  const owners = ownerOf(path);
  let expected = sent;
  const entry = owners[0]!;
  if (typeof entry.at(-1) === "number") {
    const list = entry.slice(0, -1);
    const at = (root: unknown) => list.reduce<unknown>((node, part) => (node as Record<string | number, unknown> | undefined)?.[part], root);
    const before = at(sent);
    const after = at(read);
    if (Array.isArray(before) && Array.isArray(after) && after.length === before.length - 1) {
      expected = copyAt(sent, list, (parent, last) => { parent[last!] = before.filter((_, index) => index !== entry.at(-1)); });
    }
  }
  const inside = (changed: ThemePath) => owners.some((owner) => owner.every((part, index) => changed[index] === part));
  return differingPaths(expected, read).filter((changed) => !inside(changed));
}

/** The document with the string at `path` replaced by `LATER_MEMBER`. */
export function withLaterMember(document: unknown, path: ThemePath): unknown {
  return copyAt(document, path, (parent, last) => { parent[last!] = LATER_MEMBER; });
}

const startsWith = (path: readonly PropertyKey[], prefix: readonly PropertyKey[]) => prefix.every((part, index) => path[index] === part);

/**
 * Every string of a current document that is a member of a closed list: the
 * strings whose replacement by `LATER_MEMBER` the schema refuses as a value
 * it does not know (an enum, a literal, a union's discriminator) at that
 * place or the union holding it, never a format or a bound. One path per
 * place a list is met (indexes and record keys alike), so a long list of the
 * same entries is proved once per kind of entry.
 */
export function closedListPaths(document: unknown): ThemePath[] {
  const seen = new Set<string>();
  const paths: ThemePath[] = [];
  for (const path of stringPaths(document)) {
    // The kind of place: the path with indexes elided, with what each object on the way is (a section's type, a block's variant).
    let node: unknown = document;
    const kind: string[] = [];
    for (const part of path) {
      const record = node as Json;
      const what = [record.type, record.kind, record.variant, record.layout, record.part].find((value) => typeof value === "string") ?? "";
      kind.push(`${typeof part === "number" ? "#" : part}(${what})`);
      node = (node as Record<string | number, unknown>)[part];
    }
    const key = kind.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    const result = storefrontThemeDocumentSchema.safeParse(withLaterMember(document, path));
    if (result.success) continue;
    if (result.error.issues.every((issue) => (issue.code === "invalid_value" || issue.code === "invalid_union") && startsWith(path, issue.path))) paths.push(path);
  }
  return paths;
}

/** The paths where two JSON values differ (a key present on one side only included). */
export function differingPaths(left: unknown, right: unknown, path: ThemePath = []): ThemePath[] {
  if (Object.is(left, right)) return [];
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return [path];
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return [path];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => differingPaths((left as Json)[key], (right as Json)[key], [...path, Array.isArray(left) ? Number(key) : key]));
}
