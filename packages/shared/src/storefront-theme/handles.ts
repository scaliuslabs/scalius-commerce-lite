// Catalogue references by handle in what an app declares for the theme
// (templates, page presets) and in the section settings an app writes: an app
// is written before any category or collection id exists, so it names them by
// handle and the platform resolves the handle to the id when the theme is
// applied or listed. Three forms, anywhere in the value:
//
//   - a product source `{ "kind": "category" | "collection", "handle": "laptops" }`
//     becomes `{ kind, categoryId | collectionId: <id> }`;
//   - a string `@category:<handle>` or `@collection:<handle>` (in a section's
//     id list: `categoryIds`, `collectionIds`) becomes the id;
//   - a link `/collections/@<handle>` or `/categories/@<handle>` (with an
//     optional `?query` or `#fragment`) becomes the resource's route:
//     `/collections/<id>`, `/categories/<handle>`.
//
// A handle is the resource's `slug` (categories, and collections since
// migration 0170). Resolution is a pure walk over the value with a lookup the
// caller provides; nothing here reads a database.

import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from "../handle";

export const STOREFRONT_HANDLE_KINDS = ["category", "collection"] as const;
export type StorefrontHandleKind = (typeof STOREFRONT_HANDLE_KINDS)[number];

/** One catalogue reference by handle. */
export interface StorefrontHandleRef {
  kind: StorefrontHandleKind;
  handle: string;
}

/** The id a handle names, or null when no such (live) resource exists. */
export type StorefrontHandleLookup = (ref: StorefrontHandleRef) => string | null;

const ID_REFERENCE = /^@(category|collection):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const LINK_REFERENCE = /^\/(collections|categories)\/@([a-z0-9]+(?:-[a-z0-9]+)*)([?#].*)?$/s;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHandle(handle: string): boolean {
  return handle.length <= HANDLE_MAX_LENGTH && HANDLE_PATTERN.test(handle);
}

/** The handle reference a value is, with how to rewrite it, or null. */
function referenceOf(value: unknown): { ref: StorefrontHandleRef; rewrite: (id: string) => unknown } | null {
  if (typeof value === "string") {
    const id = ID_REFERENCE.exec(value);
    if (id && validHandle(id[2]!)) return { ref: { kind: id[1] as StorefrontHandleKind, handle: id[2]! }, rewrite: (resolved) => resolved };
    const link = LINK_REFERENCE.exec(value);
    if (link && validHandle(link[2]!)) {
      const kind: StorefrontHandleKind = link[1] === "collections" ? "collection" : "category";
      const rest = link[3] ?? "";
      // A category's route is its handle; a collection's is its id.
      return { ref: { kind, handle: link[2]! }, rewrite: (resolved) => `/${link[1]}/${kind === "category" ? link[2] : resolved}${rest}` };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || typeof value.handle !== "string" || (value.kind !== "category" && value.kind !== "collection")) return null;
  if (!validHandle(value.handle)) return null;
  const kind = value.kind;
  return {
    ref: { kind, handle: value.handle },
    rewrite: (resolved) => (kind === "category" ? { kind, categoryId: resolved } : { kind, collectionId: resolved }),
  };
}

/** Every handle reference in a value, each once, in the order first met. */
export function storefrontHandleRefs(value: unknown): StorefrontHandleRef[] {
  const found = new Map<string, StorefrontHandleRef>();
  const visit = (node: unknown) => {
    const reference = referenceOf(node);
    if (reference) {
      found.set(storefrontHandleKey(reference.ref), reference.ref);
      return;
    }
    if (Array.isArray(node)) node.forEach(visit);
    else if (isRecord(node)) Object.values(node).forEach(visit);
  };
  visit(value);
  return [...found.values()];
}

/** `<kind>:<handle>`: one reference's key in a lookup map. */
export function storefrontHandleKey(ref: StorefrontHandleRef): string {
  return `${ref.kind}:${ref.handle}`;
}

/**
 * The value with every handle reference replaced by what it names, and the
 * references the lookup could not resolve (left in place). The input is not
 * changed.
 */
export function resolveStorefrontHandles(value: unknown, lookup: StorefrontHandleLookup): { value: unknown; unresolved: StorefrontHandleRef[] } {
  const unresolved = new Map<string, StorefrontHandleRef>();
  const walk = (node: unknown): unknown => {
    const reference = referenceOf(node);
    if (reference) {
      const id = lookup(reference.ref);
      if (id === null) {
        unresolved.set(storefrontHandleKey(reference.ref), reference.ref);
        return node;
      }
      return reference.rewrite(id);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  const resolved = walk(value);
  return { value: resolved, unresolved: [...unresolved.values()] };
}

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A stand-in id for a reference, for checking a declaration's shape without a
 * store (manifest validation, packing): within the record-id length, and
 * distinct for distinct handles, so id lists stay unique.
 */
export function storefrontHandlePlaceholder(ref: StorefrontHandleRef): string {
  const id = `h_${ref.kind}_${ref.handle}`;
  return id.length <= 64 ? id : `h_${ref.kind}_${ref.handle.slice(0, 40)}_${shortHash(ref.handle)}`;
}
