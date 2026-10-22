// URL redirects (0181): an old storefront address that leads to another. A
// product's URL handle change writes one in the same batch as the new handle
// (on unless the merchant unticks "Redirect the old address"), and merchants
// add or remove them under Online store -> Navigation -> URL redirects.
//
// The storefront reads one only when a path answers 404
// (`resolveUrlRedirect`, declared on the `rd` dependency), so a page that
// exists never pays for the lookup. Paths are store-relative and have no
// query or fragment; a chain is collapsed on write (old -> older's target), so
// a lookup is always one hop.
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { urlRedirects } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@scalius/database/client";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { containsText } from "../../utils/text-match";
import { deps } from "../../cache-deps";

/** A path is at most this long (D1's LIKE limit is not involved: lookups are exact). */
export const URL_REDIRECT_PATH_MAX = 255;
/** The dashboard list reads at most this many, newest first. */
export const URL_REDIRECT_LIST_MAX = 500;

/**
 * The store-relative form of a typed address: "/products/old-lamp" from
 * "/products/old-lamp/", "products/old-lamp" or the store's full URL. Null
 * when it can't be one: a query, a fragment, spaces, a backslash, another
 * site's protocol-relative URL, or too long.
 */
export function normalizeRedirectPath(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  if (value.startsWith("//") || /[\s\\?#]/.test(value)) return null;
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (value === "/" || value.length > URL_REDIRECT_PATH_MAX) return value === "/" ? "/" : null;
  return value;
}

/** A product page's path for a handle. */
export const productPath = (slug: string) => `/products/${slug}`;

/**
 * The statements that make `fromPath` lead to `toPath`, for the caller's own
 * batch: the new address stops redirecting (it is a page again), every
 * redirect that led to the old address now leads to the new one, then the old
 * address leads to the new one. Order matters: A -> B then B -> A leaves only
 * B -> A, never a loop.
 */
export function buildUrlRedirectStatements(db: Database, fromPath: string, toPath: string): BatchItem<"sqlite">[] {
  if (fromPath === toPath) return [];
  return [
    db.delete(urlRedirects).where(eq(urlRedirects.fromPath, toPath)) as unknown as BatchItem<"sqlite">,
    db.update(urlRedirects)
      .set({ toPath, updatedAt: sql`unixepoch()` })
      .where(eq(urlRedirects.toPath, fromPath)) as unknown as BatchItem<"sqlite">,
    db.insert(urlRedirects)
      .values({ id: `rdr_${nanoid(16)}`, fromPath, toPath })
      .onConflictDoUpdate({ target: urlRedirects.fromPath, set: { toPath, updatedAt: sql`unixepoch()` } }) as unknown as BatchItem<"sqlite">,
  ];
}

/**
 * Where an address that answered 404 leads, or null. One indexed read on the
 * storefront's not-found path only; cached on `rd`.
 */
export async function resolveUrlRedirect(db: Database, path: string): Promise<string | null> {
  deps.redirects();
  const from = normalizeRedirectPath(path);
  if (!from || from === "/") return null;
  const row = await db.select({ toPath: urlRedirects.toPath }).from(urlRedirects)
    .where(eq(urlRedirects.fromPath, from)).get();
  return row?.toPath ?? null;
}

export interface UrlRedirectView {
  id: string;
  fromPath: string;
  toPath: string;
  createdAt: string;
}

const view = (row: { id: string; fromPath: string; toPath: string; createdAt: Date }): UrlRedirectView => ({
  id: row.id,
  fromPath: row.fromPath,
  toPath: row.toPath,
  createdAt: row.createdAt.toISOString(),
});

/** The newest redirects (at most 500), optionally those whose paths contain `search`. */
export async function listUrlRedirects(db: Database, input: { search?: string } = {}): Promise<{ redirects: UrlRedirectView[]; truncated: boolean }> {
  const search = input.search?.trim() ?? "";
  const rows = await db.select({
    id: urlRedirects.id,
    fromPath: urlRedirects.fromPath,
    toPath: urlRedirects.toPath,
    createdAt: urlRedirects.createdAt,
  }).from(urlRedirects)
    .where(search ? sql`(${containsText(urlRedirects.fromPath, search)} OR ${containsText(urlRedirects.toPath, search)})` : undefined)
    .orderBy(desc(urlRedirects.createdAt), desc(urlRedirects.id))
    .limit(URL_REDIRECT_LIST_MAX + 1);
  return { redirects: rows.slice(0, URL_REDIRECT_LIST_MAX).map(view), truncated: rows.length > URL_REDIRECT_LIST_MAX };
}

/** Adds (or re-points) a redirect a merchant typed. */
export async function createUrlRedirect(db: Database, input: { fromPath: string; toPath: string }): Promise<UrlRedirectView> {
  const fromPath = normalizeRedirectPath(input.fromPath);
  const toPath = normalizeRedirectPath(input.toPath);
  if (!fromPath || fromPath === "/") throw new ValidationError("Enter the old address as a path on your store, like /products/old-name.", { field: "fromPath" });
  if (!toPath) throw new ValidationError("Enter where it should go as a path on your store, like /products/new-name.", { field: "toPath" });
  if (fromPath === toPath) throw new ValidationError("The old and new addresses are the same.", { field: "toPath" });
  // One hop always: a target that itself redirects is followed now.
  const onward = await db.select({ toPath: urlRedirects.toPath }).from(urlRedirects).where(eq(urlRedirects.fromPath, toPath)).get();
  const target = onward?.toPath ?? toPath;
  if (target === fromPath) throw new ConflictError("That would send the two addresses to each other. Delete the other redirect first.");
  await db.batch([
    // Redirects that led to the old address follow it to the new one.
    db.update(urlRedirects).set({ toPath: target, updatedAt: sql`unixepoch()` }).where(eq(urlRedirects.toPath, fromPath)),
    db.insert(urlRedirects)
      .values({ id: `rdr_${nanoid(16)}`, fromPath, toPath: target })
      .onConflictDoUpdate({ target: urlRedirects.fromPath, set: { toPath: target, updatedAt: sql`unixepoch()` } }),
  ]);
  const row = await db.select({
    id: urlRedirects.id,
    fromPath: urlRedirects.fromPath,
    toPath: urlRedirects.toPath,
    createdAt: urlRedirects.createdAt,
  }).from(urlRedirects).where(eq(urlRedirects.fromPath, fromPath)).get();
  if (!row) throw new NotFoundError("Redirect not found");
  return view(row);
}

export async function deleteUrlRedirect(db: Database, id: string): Promise<void> {
  const deleted = await db.delete(urlRedirects).where(eq(urlRedirects.id, id)).returning({ id: urlRedirects.id });
  if (deleted.length === 0) throw new NotFoundError("Redirect not found");
}
