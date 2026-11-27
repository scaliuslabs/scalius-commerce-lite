// The documents a theme read is proved over, and the two ways a later release
// grows one without raising its version: a key added to an object, and a
// member added to a closed list. Shared by the stored read's proof
// (read-future-keys.test.ts) and the storefront's read of what the API sends
// (apps/storefront storefront-theme-read-corpus.test.ts).
import { STOREFRONT_TEMPLATE_IDS, storefrontThemeDocumentSchema } from "./document";
import { storefrontTemplateTheme } from "./templates";

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
  return [...goldens, ...STOREFRONT_TEMPLATE_IDS.map((id): [string, unknown] => [`template ${id}`, storefrontTemplateTheme(id)])];
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
